import {createHash,randomBytes,timingSafeEqual} from "node:crypto";
import {z} from "zod";
import Business from "../models/Business.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import {hasBusinessFeature} from "../utils/businessPlans.js";
import {calculateProductPieces,calculateProductWeight,MIN_ORDER_WEIGHT_GRAMS} from "../utils/productWeight.js";
import {calculateRegionalDeliveryChargePaisa,resolveDeliveryRate} from "../utils/deliveryPricing.js";
import {getAnalyticsDateRange} from "../utils/analyticsPeriod.js";
import {getBusinessPaymentMethod} from "../utils/businessPaymentMethod.js";
import {createPaymentInfoSnapshot} from "../utils/paymentInfoSnapshot.js";
import {findPostalPincodeDetails,PincodeLookupError} from "../services/postalPincode.js";

const checkoutSchema=z.object({
  items:z.array(z.object({
    productId:z.string().regex(/^[a-f\d]{24}$/i),
    packetQuantity:z.coerce.number().int().min(1).max(100000)
  })).min(1).max(50)
});
const billSchema=z.object({
  regionId:z.string().regex(/^[a-f\d]{24}$/i),
  deliveryChargePaisa:z.coerce.number().int().min(0).max(100000000).optional(),
  billDescription:z.string().trim().max(500).optional().default("")
});
const tokenHash=token=>createHash("sha256").update(token).digest("hex");

function validationMessage(error){
  return error.issues?.[0]?.message||"Please check the submitted details.";
}
function displayWeightGrams(value){
  return value>=1000?`${Number((value/1000).toFixed(2))} kg`:`${Math.ceil(value)} g`;
}
function minimumOrderMessage(business,totalWeightGrams,items){
  const minimumWeightGrams=Number.isSafeInteger(business.minimumOrderWeightGrams)&&business.minimumOrderWeightGrams>0
    ?business.minimumOrderWeightGrams
    :MIN_ORDER_WEIGHT_GRAMS;
  const remainingWeightGrams=Math.max(0,minimumWeightGrams-totalWeightGrams);
  const minimumUnitWeightGrams=Math.max(0,...items.map(item=>Number(item.packetWeightGrams)||0));
  const remainingUnits=minimumUnitWeightGrams?Math.ceil(remainingWeightGrams/minimumUnitWeightGrams):1;
  const values={
    remainingUnits:String(remainingUnits),
    unitLabel:remainingUnits===1?"unit":"units",
    remainingWeight:displayWeightGrams(remainingWeightGrams),
    minimumWeight:displayWeightGrams(minimumWeightGrams)
  };
  const mode=business.minimumOrderDisplayMode==="QUANTITY"?"QUANTITY":"WEIGHT";
  const template=mode==="QUANTITY"
    ?business.minimumOrderQuantityMessage||"Add at least {remainingUnits} more {unitLabel} to place your order (minimum {minimumWeight})."
    :business.minimumOrderWeightMessage||"Add {remainingWeight} more to place your order (minimum {minimumWeight}).";
  const message=template.replace(/\{(remainingUnits|unitLabel|remainingWeight|minimumWeight)\}/g,(_match,key)=>values[key]);
  return {message,minimumOrderWeightGrams:minimumWeightGrams,remainingWeightGrams,minimumAdditionalUnits:remainingUnits,minimumOrderDisplayMode:mode};
}
function orderView(order){
  const {customerAccessTokenHash,paymentProofPublicId,customerId,unreadCustomerOrderUpdates,...visible}=order.toObject?order.toObject():order;
  return visible;
}
async function lookupOrderPincode(pincode,source){
  try{return await findPostalPincodeDetails(pincode);}
  catch(error){
    if(!(error instanceof PincodeLookupError))throw error;
    console.error(`India Post PIN lookup failed for the ${source} address. Delivery charge will remain pending.`,error);
    return null;
  }
}
function billBusinessSnapshot(business){
  return {
    name:business.name,
    logoUrl:business.logoUrl,
    contactPhone:business.contactPhone,
    address:business.address,
    city:business.city,
    state:business.state,
    pincode:business.pincode
  };
}
function createOrderBillSnapshot({business,customer,items,totalWeightGrams,productSubtotalPaisa,deliveryChargePaisa,region,paymentInfoSnapshot,sentAt}){
  const payment=paymentInfoSnapshot||{
    paymentMethodSnapshot:"OFF",
    paymentQrSnapshot:"",
    upiIdSnapshot:"",
    paymentInstructionsSnapshot:""
  };
  return {
    version:1,
    sentAt,
    paymentMethodSnapshot:payment.paymentMethodSnapshot,
    billDescriptionSnapshot:"",
    business:billBusinessSnapshot(business),
    customer:{name:customer.customerName,phone:customer.phone,address:customer.deliveryAddress,district:customer.district,state:customer.state,pincode:customer.pincode},
    items:items.map(item=>({name:item.name,packetQuantity:item.packetQuantity,unitLabel:item.unitLabel,packetPrice:item.packetPrice,lineTotal:item.lineTotal})),
    totalWeightGrams,
    region:{...(region.id?{id:region.id}:{}),name:region.name,ratePerKgPaisa:region.ratePerKgPaisa,matchType:region.matchType},
    productSubtotalPaisa,
    calculatedDeliveryChargePaisa:deliveryChargePaisa,
    deliveryChargePaisa,
    totalPaisa:productSubtotalPaisa+deliveryChargePaisa,
    paymentQrSnapshot:payment.paymentQrSnapshot||"",
    upiIdSnapshot:payment.upiIdSnapshot||"",
    paymentInstructionsSnapshot:payment.paymentInstructionsSnapshot||""
  };
}
function addTokenHeader(req,res,next){
  req.customerOrderToken=String(req.get("x-order-access-token")||"");
  next();
}
async function findCustomerOrder(req,res){
  const token=req.customerOrderToken;
  const filter={orderNumber:req.params.orderNumber};
  if(req.params.slug){
    const business=await Business.findOne({slug:req.params.slug}).select("_id");
    if(!business)return res.status(404).json({message:"This store is not available."});
    filter.businessId=business._id;
  }
  const order=await Order.findOne(filter).select("+customerAccessTokenHash");
  if(!order)return res.status(404).json({message:"Order not found."});
  if(req.customer&&req.params.slug&&order.customerId?.toString()===req.customer._id.toString())return order;
  if(token.length<32)return res.status(401).json({message:"Sign in to the customer account used for this order, or use its secure order link."});
  const expected=Buffer.from(order.customerAccessTokenHash,"hex");
  const actual=Buffer.from(tokenHash(token),"hex");
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return res.status(401).json({message:"Order access could not be verified."});
  return order;
}
async function restoreOrderStock(order,items=order.items){
  if(items.length)await Product.bulkWrite(items.map(item=>({
    updateOne:{
      filter:{_id:item.productId,businessId:order.businessId},
      update:{$inc:{stockPackets:item.packetQuantity}}
    }
  })));
}
async function reserveOrderStock(order){
  const reserved=[];
  try{
    for(const item of order.items){
      const product=await Product.findOneAndUpdate(
        {_id:item.productId,businessId:order.businessId,status:"ACTIVE",stockPackets:{$gte:item.packetQuantity}},
        {$inc:{stockPackets:-item.packetQuantity}},
        {new:true}
      );
      if(!product){
        const error=new Error(`There is not enough stock to re-accept ${item.name}.`);
        error.status=409;
        throw error;
      }
      reserved.push(item);
    }
    return reserved;
  }catch(error){
    try{await restoreOrderStock(order,reserved);}
    catch(rollbackError){
      console.error("Could not restore a partial stock reservation after an order decision failed.",rollbackError);
      const failure=new Error("The order could not be accepted and a stock reservation requires review.");
      failure.status=500;
      throw failure;
    }
    throw error;
  }
}

export async function createCustomerOrder(req,res){
  if(!req.customer)return res.status(401).json({message:"Sign in or create a customer account before placing an order."});
  if(!req.customer.customerName||!req.customer.deliveryAddress||!req.customer.pincode||!req.customer.district||!req.customer.state)return res.status(400).json({message:"Complete your name, delivery address, pincode, district, and state in your customer profile before placing an order."});
  const parsed=checkoutSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:validationMessage(parsed.error)});
  const business=await Business.findOne({slug:req.params.slug,status:"ACTIVE"});
  if(!business)return res.status(404).json({message:"This store is not available."});

  const requested=new Map();
  for(const item of parsed.data.items)requested.set(item.productId,(requested.get(item.productId)||0)+item.packetQuantity);
  const [products,customerLocation,businessLocation]=await Promise.all([
    Product.find({_id:{$in:Array.from(requested.keys())},businessId:business._id,status:"ACTIVE"}).lean(),
    lookupOrderPincode(req.customer.pincode,"customer"),
    lookupOrderPincode(business.pincode,"business")
  ]);
  if(products.length!==requested.size)return res.status(409).json({message:"A product in your cart is no longer available from this store."});

  const items=[];
  for(const product of products){
    const packetQuantity=requested.get(product._id.toString());
    let weightDetails,pieces;
    try{
      weightDetails=calculateProductWeight(product,packetQuantity);
      pieces=calculateProductPieces(product,packetQuantity);
    }catch(error){return res.status(409).json({message:`${product.name} has an invalid weight configuration: ${error.message}`});}
    if(!Number.isFinite(product.packetPrice)||product.packetPrice<=0)return res.status(409).json({message:`${product.name} is not configured for sale.`});
    if(!Number.isSafeInteger(product.stockPackets)||product.stockPackets<packetQuantity)return res.status(409).json({message:`There are not enough units of ${product.name} in stock.`});
    const lineTotal=Math.round(product.packetPrice*100)*packetQuantity/100;
    items.push({
      productId:product._id,
      name:product.name,
      category:product.category,
      quantity:packetQuantity,
      packetQuantity,
      weightCalculationMethod:weightDetails.method,
      piecesPerBundle:weightDetails.piecesPerBundle,
      bundleWeightGrams:weightDetails.bundleWeightGrams,
      piecesPerKg:weightDetails.piecesPerKg,
      unitWeightGrams:weightDetails.piecesPerUnitGrams,
      unitLabel:weightDetails.unitLabel,
      piecesPerPacket:weightDetails.method==="BUNDLE"?weightDetails.piecesPerBundle:1,
      packetWeightGrams:weightDetails.piecesPerUnitGrams,
      packetPrice:product.packetPrice,
      quantityWeightG:weightDetails.weightGrams,
      lineTotal,
      imageUrl:product.imageUrl
    });
  }
  const totalWeightGrams=Number(items.reduce((sum,item)=>sum+item.quantityWeightG,0).toFixed(6));
  const minimumOrder=minimumOrderMessage(business,totalWeightGrams,items);
  if(totalWeightGrams<minimumOrder.minimumOrderWeightGrams)return res.status(400).json({...minimumOrder,totalWeightGrams});
  const subtotalInr=items.reduce((sum,item)=>sum+Math.round(item.lineTotal*100),0)/100;
  const deliveryRegion=resolveDeliveryRate({
    business,
    customerPincode:req.customer.pincode,
    customerLocation,
    businessLocation
  });
  let deliveryChargePaisa=0;
  if(deliveryRegion){
    try{deliveryChargePaisa=calculateRegionalDeliveryChargePaisa(totalWeightGrams,deliveryRegion.ratePerKgPaisa);}
    catch(error){return res.status(409).json({message:error.message});}
  }
  const productSubtotalPaisa=Math.round(subtotalInr*100);
  const totalPaisa=productSubtotalPaisa+deliveryChargePaisa;
  if(!Number.isSafeInteger(productSubtotalPaisa)||!Number.isSafeInteger(totalPaisa))return res.status(409).json({message:"The order total exceeds the supported billing range."});
  const paymentInfoSnapshot=createPaymentInfoSnapshot(business);
  const sentAt=new Date();
  const billSnapshot=deliveryRegion?createOrderBillSnapshot({
    business,
    customer:{...req.customer,district:customerLocation?.district||req.customer.district,state:customerLocation?.state||req.customer.state},
    items,
    totalWeightGrams,
    productSubtotalPaisa,
    deliveryChargePaisa,
    region:deliveryRegion,
    paymentInfoSnapshot,
    sentAt
  }):null;

  const reserved=[];
  try{
    for(const item of items){
      const product=await Product.findOneAndUpdate(
        {_id:item.productId,businessId:business._id,status:"ACTIVE",stockPackets:{$gte:item.packetQuantity}},
        {$inc:{stockPackets:-item.packetQuantity}},
        {new:true}
      );
      if(!product){
        const error=new Error(`There is not enough stock for ${item.name}.`);
        error.status=409;
        throw error;
      }
      reserved.push(item);
    }
    const accessToken=randomBytes(32).toString("base64url");
    const order=await Order.create({
      businessId:business._id,
      customerId:req.customer?._id||null,
      orderNumber:`XW-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`,
      items,
      customerName:req.customer.customerName,
      customerPhone:req.customer.phone,
      deliveryAddress:req.customer.deliveryAddress,
      deliveryPincode:req.customer.pincode,
      deliveryDistrict:customerLocation?.district||req.customer.district,
      deliveryState:customerLocation?.state||req.customer.state,
      deliveryZoneName:deliveryRegion?.name||"",
      deliveryRegionSnapshot:billSnapshot?.region||null,
      deliveryFeePending:!deliveryRegion,
      billSnapshot,
      totalPieces:items.reduce((sum,item)=>sum+item.piecesPerPacket*item.packetQuantity,0),
      totalWeightGrams,
      totalWeightG:totalWeightGrams,
      productTotalInr:subtotalInr,
      subtotalInr,
      deliveryChargeInr:deliveryChargePaisa/100,
      deliveryFeeInr:deliveryChargePaisa/100,
      grandTotalInr:totalPaisa/100,
      totalInr:totalPaisa/100,
      paymentInfoSnapshot,
      paymentQrSnapshot:paymentInfoSnapshot?.paymentQrSnapshot||"",
      paymentQrSnapshotPublicId:paymentInfoSnapshot?.paymentQrSnapshot?business.paymentQrPublicId||"":"",
      upiIdSnapshot:paymentInfoSnapshot?.upiIdSnapshot||"",
      paymentInstructionsSnapshot:paymentInfoSnapshot?.paymentInstructionsSnapshot||"",
      customerAccessTokenHash:tokenHash(accessToken)
    });
    return res.status(201).json({order:orderView(order),accessToken});
  }catch(error){
    if(res.headersSent)throw error;
    if(res.statusCode<400)res.status(error.status||500);
    if(res.statusCode>=500)console.error("Could not place order.",error);
    try{
      await Promise.all(reserved.map(item=>Product.updateOne(
        {_id:item.productId,businessId:business._id},
        {$inc:{stockPackets:item.packetQuantity}}
      )));
    }catch(rollbackError){
      console.error("Could not restore reserved product stock after a failed order.",rollbackError);
      return res.status(500).json({message:"The order could not be saved and a stock reservation requires review."});
    }
    if(error.status)return res.status(error.status).json({message:error.message});
    if(error.code===11000)return res.status(409).json({message:"This order could not be assigned a unique ID. Please try again."});
    return res.status(500).json({message:"The order could not be saved. No stock was reserved."});
  }
}

export async function getCustomerOrder(req,res){
  const order=await findCustomerOrder(req,res);
  if(!order||res.headersSent)return;
  res.json({order:orderView(order)});
}

export async function getBusinessOrder(req,res){
  if(!/^[a-f\d]{24}$/i.test(req.params.id||""))return res.status(400).json({message:"Invalid order ID."});
  const order=await Order.findOne({_id:req.params.id,businessId:req.tenantId});
  if(!order)return res.status(404).json({message:"Order not found in your store."});
  res.json({order:orderView(order)});
}

export async function listBusinessOrders(req,res){
  const parsed=z.object({archived:z.enum(["true","false"]).optional()}).safeParse(req.query);
  if(!parsed.success)return res.status(400).json({message:"Choose a valid order archive view."});
  const archived=parsed.data.archived==="true";
  const filter=archived
    ?{businessId:req.tenantId,$or:[{businessArchivedAt:{$ne:null}},{status:{$in:["REJECTED","CANCELLED","DELIVERED"]}}]}
    :{businessId:req.tenantId,businessArchivedAt:null,status:{$in:["PLACED","ACCEPTED"]}};
  const orders=await Order.find(filter).sort({createdAt:-1}).limit(100).lean();
  res.json({orders:orders.map(({customerId,businessArchivedBy,...order})=>order)});
}

export async function archiveBusinessOrder(req,res){
  const parsed=z.object({archived:z.boolean()}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:"Choose whether to archive or restore this order."});
  const archived=parsed.data.archived;
  const order=await Order.findOneAndUpdate(
    {_id:req.params.id,businessId:req.tenantId},
    {$set:{
      businessArchivedAt:archived?new Date():null,
      businessArchivedBy:archived?req.user._id:null
    }},
    {new:true,runValidators:true}
  ).select("_id status");
  if(!order)return res.status(404).json({message:"Order not found in your store."});
  res.json({message:archived?"Order archived. Its history and analytics are preserved.":["REJECTED","CANCELLED","DELIVERED"].includes(order.status)?"Order unarchived. It remains in order history.":"Order restored to current orders."});
}

export async function getBusinessOrderAnalytics(req,res){
  const business=await Business.findOne({_id:req.tenantId,ownerId:req.user._id,status:"ACTIVE"}).select("subscriptionFeatures");
  if(!business)return res.status(404).json({message:"Your approved business workspace was not found."});
  if(!hasBusinessFeature(business,"analytics"))return res.status(403).json({message:"Sales analytics are available when Xyron Admin enables the analytics feature for your business plan."});
  const parsed=z.object({period:z.enum(["today","week","month"]).default("week")}).safeParse(req.query);
  if(!parsed.success)return res.status(400).json({message:"Choose a valid analytics period."});
  const {start,end}=getAnalyticsDateRange(parsed.data.period);
  const [report]=await Order.aggregate([
    {$match:{businessId:business._id,createdAt:{$gte:start,$lt:end}}},
    {$facet:{
      summary:[{$group:{
        _id:null,
        totalOrders:{$sum:1},
        acceptedOrders:{$sum:{$cond:[{$eq:["$status","ACCEPTED"]},1,0]}},
        unseenOrders:{$sum:{$cond:[{$eq:["$status","PLACED"]},1,0]}},
        rejectedOrders:{$sum:{$cond:[{$eq:["$status","REJECTED"]},1,0]}},
        acceptedOrderValueInr:{$sum:{$cond:[{$eq:["$status","ACCEPTED"]},"$totalInr",0]}},
        verifiedPaymentInr:{$sum:{$cond:[{$eq:["$paymentStatus","VERIFIED"]},"$totalInr",0]}}
      }}],
      dailyGroups:[
        {$group:{
          _id:{$dateToString:{format:"%Y-%m-%d",date:"$createdAt",timezone:"Asia/Kolkata"}},
          totalOrders:{$sum:1},
          acceptedOrders:{$sum:{$cond:[{$eq:["$status","ACCEPTED"]},1,0]}},
          acceptedOrderValueInr:{$sum:{$cond:[{$eq:["$status","ACCEPTED"]},"$totalInr",0]}},
          verifiedPaymentInr:{$sum:{$cond:[{$eq:["$paymentStatus","VERIFIED"]},"$totalInr",0]}}
        }},
        {$sort:{_id:-1}}
      ]
    }}
  ]);
  const summary=report?.summary[0]||{totalOrders:0,acceptedOrders:0,unseenOrders:0,rejectedOrders:0,acceptedOrderValueInr:0,verifiedPaymentInr:0};
  const dailyGroups=(report?.dailyGroups||[]).map(({_id,...group})=>({date:_id,...group}));
  res.json({period:parsed.data.period,from:start,to:end,summary,dailyGroups});
}

export async function listCustomerOrders(req,res){
  const parsed=z.object({page:z.coerce.number().int().min(1).max(100000),view:z.enum(["current","history"]).default("current")}).safeParse({page:req.query.page??1,view:req.query.view});
  if(!parsed.success)return res.status(400).json({message:"Invalid order history page."});
  const business=await Business.findOne({slug:req.params.slug,status:"ACTIVE"}).select("_id");
  if(!business)return res.status(404).json({message:"This store is not available."});
  const page=parsed.data.page,limit=50,view=parsed.data.view;
  const filter={
    customerId:req.customer._id,
    businessId:business._id,
    customerArchivedAt:null,
    ...(view==="current"
      ?{businessArchivedAt:null,status:{$in:["PLACED","ACCEPTED"]}}
      :{$or:[{businessArchivedAt:{$ne:null}},{status:{$in:["REJECTED","CANCELLED","DELIVERED"]}}]})
  };
  const orders=await Order.find(filter)
    .select("orderNumber businessId customerName deliveryDistrict deliveryState totalWeightG subtotalInr deliveryFeeInr deliveryFeePending totalInr status paymentStatus unreadCustomerOrderUpdates billSnapshot.sentAt createdAt updatedAt")
    .populate("businessId","name slug")
    .sort(view==="current"?{"billSnapshot.sentAt":-1,createdAt:-1}:{createdAt:-1})
    .skip((page-1)*limit)
    .limit(limit+1)
    .lean();
  const hasMore=orders.length>limit;
  if(hasMore)orders.pop();
  res.json({orders:orders.map(order=>({
    ...order,
    billSentAt:order.billSnapshot?.sentAt||null,
    unreadUpdateCount:order.unreadCustomerOrderUpdates||0
  })),hasMore,page});
}

export async function archiveCustomerOrder(req,res){
  const business=await Business.findOne({slug:req.params.slug,status:"ACTIVE"}).select("_id");
  if(!business)return res.status(404).json({message:"This store is not available."});
  const order=await Order.findOneAndUpdate(
    {
      customerId:req.customer._id,
      businessId:business._id,
      orderNumber:req.params.orderNumber,
      customerArchivedAt:null
    },
    {$set:{customerArchivedAt:new Date()}},
    {new:true}
  ).select("_id");
  if(!order)return res.status(404).json({message:"Order not found in your customer history."});
  res.json({message:"Order removed from your history. The store retains its order record."});
}

export async function sendBusinessOrderBill(req,res){
  const parsed=billSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:validationMessage(parsed.error)});
  const order=await Order.findOne({_id:req.params.id,businessId:req.tenantId});
  if(!order)return res.status(404).json({message:"Order not found in your store."});
  if(order.status!=="ACCEPTED")return res.status(409).json({message:"Accept the order before preparing its final bill."});
  if(order.billSnapshot)return res.status(409).json({message:"The final bill was already sent and cannot be changed."});
  const business=await Business.findOne({_id:req.tenantId,status:"ACTIVE"}).select("name logoUrl contactPhone address city state pincode paymentMethod paymentQrUrl paymentQrPublicId paymentQrEnabled upiId paymentInstructions deliveryRegions");
  if(!business)return res.status(404).json({message:"Your approved business workspace was not found."});
  const paymentMethod=getBusinessPaymentMethod(business);
  if(paymentMethod==="QR"&&!business.paymentQrUrl)return res.status(409).json({message:"Upload your customer payment QR or choose another payment method before sending the final bill."});
  if(paymentMethod==="GPAY"&&!business.upiId?.trim())return res.status(409).json({message:"Add the GPay number or UPI ID in Payment settings before sending this bill."});
  const paymentInfoSnapshot=createPaymentInfoSnapshot(business);
  const region=business.deliveryRegions.find(item=>String(item._id)===parsed.data.regionId);
  if(!region)return res.status(400).json({message:"Choose a saved delivery region for this order."});
  let calculatedDeliveryChargePaisa;
  try{calculatedDeliveryChargePaisa=calculateRegionalDeliveryChargePaisa(order.totalWeightGrams,region.ratePerKgPaisa);}
  catch(error){return res.status(409).json({message:error.message});}
  const deliveryChargePaisa=parsed.data.deliveryChargePaisa??calculatedDeliveryChargePaisa;
  const productSubtotalPaisa=Math.round(Number(order.subtotalInr)*100);
  const totalPaisa=productSubtotalPaisa+deliveryChargePaisa;
  if(!Number.isSafeInteger(productSubtotalPaisa)||productSubtotalPaisa<0||!Number.isSafeInteger(totalPaisa))return res.status(409).json({message:"The order total exceeds the supported billing range."});
  const includePaymentQr=paymentMethod==="QR";
  const includeUpiId=paymentMethod==="GPAY";
  const paymentInstructions=paymentMethod==="QR"
    ?business.paymentInstructions?.trim()||"Please pay the total shown using this QR code and include your order number in the payment note."
    :paymentMethod==="GPAY"
      ?business.paymentInstructions?.trim()||"Please pay the total shown to this GPay number or UPI ID and include your order number in the payment note."
      :"";
  const sentAt=new Date();
  const billSnapshot={
    version:1,
    sentAt,
    paymentMethodSnapshot:paymentMethod,
    billDescriptionSnapshot:parsed.data.billDescription,
    business:{name:business.name,logoUrl:business.logoUrl,contactPhone:business.contactPhone,address:business.address,city:business.city,state:business.state,pincode:business.pincode},
    customer:{name:order.customerName,phone:order.customerPhone,address:order.deliveryAddress,district:order.deliveryDistrict,state:order.deliveryState,pincode:order.deliveryPincode},
    items:order.items.map(item=>({name:item.name,packetQuantity:item.packetQuantity,unitLabel:item.unitLabel,packetPrice:item.packetPrice,lineTotal:item.lineTotal})),
    totalWeightGrams:order.totalWeightGrams,
    region:{id:String(region._id),name:region.name,ratePerKgPaisa:region.ratePerKgPaisa},
    productSubtotalPaisa,
    calculatedDeliveryChargePaisa,
    deliveryChargePaisa,
    totalPaisa,
    paymentQrSnapshot:includePaymentQr?business.paymentQrUrl:"",
    upiIdSnapshot:includeUpiId?business.upiId||"":"",
    paymentInstructionsSnapshot:paymentInstructions
  };
  const updated=await Order.findOneAndUpdate(
    {_id:order._id,businessId:req.tenantId,status:"ACCEPTED",billSnapshot:null},
    {
      $set:{
        billSnapshot,
        deliveryRegionSnapshot:billSnapshot.region,
        deliveryZoneName:region.name,
        deliveryChargeInr:deliveryChargePaisa/100,
        deliveryFeeInr:deliveryChargePaisa/100,
        deliveryFeePending:false,
        grandTotalInr:totalPaisa/100,
        totalInr:totalPaisa/100,
        paymentInfoSnapshot,
        paymentQrSnapshot:includePaymentQr?business.paymentQrUrl:"",
        paymentQrSnapshotPublicId:includePaymentQr?business.paymentQrPublicId||"":"",
        upiIdSnapshot:includeUpiId?business.upiId||"":"",
        paymentInstructionsSnapshot:paymentInstructions
      },
      $inc:{unreadCustomerOrderUpdates:1}
    },
    {new:true,runValidators:true}
  );
  if(!updated)return res.status(409).json({message:"This order changed while you were preparing its bill. Refresh and try again."});
  res.json({order:orderView(updated)});
}

export async function updateBusinessOrderStatus(req,res){
  const parsed=z.object({status:z.enum(["ACCEPTED","REJECTED"])}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:validationMessage(parsed.error)});
  const order=await Order.findOne({_id:req.params.id,businessId:req.tenantId});
  if(!order)return res.status(404).json({message:"Order not found in your store."});
  const previousStatus=order.status,targetStatus=parsed.data.status;
  const wasRejected=["REJECTED","CANCELLED"].includes(previousStatus);
  if(previousStatus===targetStatus)return res.json({order:orderView(order)});
  if(targetStatus==="REJECTED"&&["DISPATCHED","DELIVERED"].includes(previousStatus)){
    return res.status(409).json({message:"An order that has already been dispatched or delivered cannot be rejected."});
  }
  let reserved=[];
  if(targetStatus==="ACCEPTED"&&wasRejected){
    try{reserved=await reserveOrderStock(order);}
    catch(error){return res.status(error.status||409).json({message:error.message});}
  }
  let updated;
  try{
    const update={$set:{status:targetStatus}};
    if(targetStatus==="ACCEPTED")update.$inc={unreadCustomerOrderUpdates:1};
    updated=await Order.findOneAndUpdate(
      {_id:order._id,businessId:req.tenantId,status:previousStatus},
      update,
      {new:true,runValidators:true}
    );
  }catch(error){
    if(reserved.length)await restoreOrderStock(order,reserved);
    throw error;
  }
  if(!updated){
    if(reserved.length)await restoreOrderStock(order,reserved);
    return res.status(409).json({message:"This order changed while you were updating it. Refresh and try again."});
  }
  if(targetStatus==="REJECTED"&&!wasRejected){
    try{await restoreOrderStock(order);}
    catch(error){console.error("The order was rejected, but its reserved stock could not be restored.",error);return res.status(500).json({message:"The order was rejected, but stock restoration needs review."});}
  }
  res.json({order:orderView(updated)});
}

export async function markCustomerOrderNotificationsRead(req,res){
  const order=await findCustomerOrder(req,res);
  if(!order||res.headersSent)return;
  const result=await Order.updateOne(
    {_id:order._id,businessId:order.businessId,unreadCustomerOrderUpdates:{$gt:0}},
    {$set:{unreadCustomerOrderUpdates:0}}
  );
  res.json({markedRead:result.modifiedCount===1});
}
export const customerOrderAccess=addTokenHeader;
