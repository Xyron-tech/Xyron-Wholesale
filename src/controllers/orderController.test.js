import assert from "node:assert/strict";
import {mock,test} from "node:test";
import Business from "../models/Business.js";
import Order from "../models/Order.js";
import OrderMessage from "../models/OrderMessage.js";
import Product from "../models/Product.js";
import {createCustomerOrder,getBusinessOrder,listBusinessOrders,listCustomerOrders,markCustomerOrderNotificationsRead,sendBusinessOrderBill,updateBusinessOrderStatus} from "./orderController.js";

test("accepting an order creates an unread customer alert without sending a chat message",async t=>{
  const order={_id:"order-id",businessId:"business-id",status:"PLACED",toObject(){return {...this};}};
  let statusUpdate;
  let messageCreated=false;
  t.mock.method(Order,"findOne",async()=>order);
  t.mock.method(Order,"findOneAndUpdate",async(_filter,update)=>{statusUpdate=update;return {...order,status:"ACCEPTED",unreadCustomerOrderUpdates:1};});
  t.mock.method(OrderMessage,"create",async()=>{messageCreated=true;});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await updateBusinessOrderStatus({params:{id:"order-id"},tenantId:"business-id",user:{name:"Store owner"},body:{status:"ACCEPTED"}},res);

  assert.equal(res.statusCode,200);
  assert.deepEqual(statusUpdate,{$set:{status:"ACCEPTED"},$inc:{unreadCustomerOrderUpdates:1}});
  assert.equal(messageCreated,false);
});

test("opening an order clears the customer's unread order alert",async t=>{
  const order={_id:"order-id",businessId:"business-id",customerId:"customer-id"};
  const businessQuery={select:async()=>({_id:"business-id"})};
  const orderQuery={select:async()=>order};
  let update;
  t.mock.method(Business,"findOne",()=>businessQuery);
  t.mock.method(Order,"findOne",()=>orderQuery);
  t.mock.method(Order,"updateOne",async(...args)=>{update=args;return {modifiedCount:1};});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await markCustomerOrderNotificationsRead({
    params:{slug:"store",orderNumber:"order-number"},
    customer:{_id:"customer-id"}
  },res);

  assert.deepEqual(update[0],{_id:"order-id",businessId:"business-id",unreadCustomerOrderUpdates:{$gt:0}});
  assert.deepEqual(update[1],{$set:{unreadCustomerOrderUpdates:0}});
  assert.deepEqual(res.body,{markedRead:true});
});

test("a bill sent with QR payments disabled does not include QR payment details",async t=>{
  const regionId="bbbbbbbbbbbbbbbbbbbbbbbb";
  const order={_id:"order-id",businessId:"business-id",status:"ACCEPTED",billSnapshot:null,totalWeightGrams:1000,subtotalInr:42,items:[{name:"Tea",packetQuantity:2,unitLabel:"bundle",packetPrice:21,lineTotal:42}]};
  const business={name:"Store",paymentQrEnabled:false,paymentQrUrl:"https://example.test/qr.png",paymentQrPublicId:"qr-id",upiId:"store@example",paymentInstructions:"Pay the bill",deliveryRegions:[{_id:regionId,name:"Local",ratePerKgPaisa:10000}]};
  let billUpdate;
  t.mock.method(Order,"findOne",async()=>order);
  t.mock.method(Business,"findOne",()=>({select:async()=>business}));
  t.mock.method(Order,"findOneAndUpdate",async(_filter,update)=>{billUpdate=update.$set;return {...order,...billUpdate};});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await sendBusinessOrderBill({params:{id:"order-id"},tenantId:"business-id",body:{regionId,deliveryChargePaisa:1000}},res);

  assert.equal(res.statusCode,200);
  assert.equal(billUpdate.billSnapshot.paymentQrSnapshot,"");
  assert.equal(billUpdate.billSnapshot.paymentMethodSnapshot,"OFF");
  assert.equal(billUpdate.billSnapshot.upiIdSnapshot,"");
  assert.equal(billUpdate.billSnapshot.paymentInstructionsSnapshot,"");
  assert.equal(billUpdate.billSnapshot.billDescriptionSnapshot,"");
  assert.equal(billUpdate.paymentQrSnapshot,"");
});

test("a bill snapshots GPay details and the optional description",async t=>{
  const regionId="bbbbbbbbbbbbbbbbbbbbbbbb";
  const order={_id:"order-id",businessId:"business-id",status:"ACCEPTED",billSnapshot:null,totalWeightGrams:1000,subtotalInr:42,items:[{name:"Tea",packetQuantity:2,unitLabel:"bundle",packetPrice:21,lineTotal:42}]};
  const business={name:"Store",paymentMethod:"GPAY",paymentQrEnabled:false,upiId:"9876543210",paymentInstructions:"Use the store number",deliveryRegions:[{_id:regionId,name:"Local",ratePerKgPaisa:10000}]};
  let billUpdate;
  t.mock.method(Order,"findOne",async()=>order);
  t.mock.method(Business,"findOne",()=>({select:async()=>business}));
  t.mock.method(Order,"findOneAndUpdate",async(_filter,update)=>{billUpdate=update.$set;return {...order,...billUpdate};});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await sendBusinessOrderBill({params:{id:"order-id"},tenantId:"business-id",body:{regionId,deliveryChargePaisa:1000,billDescription:"  Call before delivery  "}},res);

  assert.equal(res.statusCode,200);
  assert.equal(billUpdate.billSnapshot.paymentMethodSnapshot,"GPAY");
  assert.equal(billUpdate.billSnapshot.paymentQrSnapshot,"");
  assert.equal(billUpdate.billSnapshot.upiIdSnapshot,"9876543210");
  assert.equal(billUpdate.billSnapshot.paymentInstructionsSnapshot,"Use the store number");
  assert.equal(billUpdate.billSnapshot.billDescriptionSnapshot,"Call before delivery");
  assert.equal(billUpdate.upiIdSnapshot,"9876543210");
});

test("placing an order uses the postal PIN to calculate delivery and create the bill immediately",async t=>{
  const productId="aaaaaaaaaaaaaaaaaaaaaaaa";
  const product={_id:productId,name:"Tea",category:"Grocery",weightCalculationMethod:"BUNDLE",piecesPerBundle:10,bundleWeightGrams:1000,packetPrice:42,stockPackets:3,imageUrl:""};
  const customer={_id:"customer-id",customerName:"Customer",phone:"9876543210",deliveryAddress:"12 Main Road, Chennai",pincode:"600001",district:"Chennai",state:"Tamil Nadu"};
  const business={_id:"business-id",name:"Store",pincode:"600000",city:"Chennai",state:"Tamil Nadu",deliveryRates:{sameDistrictPaisa:8500},deliveryRegions:[],paymentMethod:"OFF"};
  let savedOrder;
  t.mock.method(globalThis,"fetch",async url=>{
    const pincode=String(url).split("/").pop();
    return new Response(JSON.stringify([{Status:"Success",PostOffice:[{Pincode:pincode,District:"Chennai",State:"Tamil Nadu",Country:"India"}]}]),{status:200,headers:{"Content-Type":"application/json"}});
  });
  t.mock.method(Business,"findOne",async()=>business);
  t.mock.method(Product,"find",()=>({lean:async()=>[product]}));
  t.mock.method(Product,"findOneAndUpdate",async()=>product);
  t.mock.method(Order,"create",async order=>{savedOrder=order;return {_id:"order-id",...order};});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await createCustomerOrder({customer,params:{slug:"store"},body:{items:[{productId,packetQuantity:1}]}},res);

  assert.equal(res.statusCode,201);
  assert.equal(savedOrder.status,"ACCEPTED");
  assert.equal(savedOrder.deliveryDistrict,"Chennai");
  assert.equal(savedOrder.deliveryState,"Tamil Nadu");
  assert.equal(savedOrder.deliveryFeePending,false);
  assert.equal(savedOrder.billSnapshot.region.name,"Same district");
  assert.equal(savedOrder.billSnapshot.deliveryChargePaisa,8500);
  assert.equal(savedOrder.billSnapshot.totalPaisa,12700);
  assert.equal(res.body.order.deliveryDistrict,"Chennai");
  assert.equal(res.body.order.deliveryState,"Tamil Nadu");
});

test("placing an order from an unpriced area succeeds with delivery pending",async t=>{
  const productId="aaaaaaaaaaaaaaaaaaaaaaaa";
  const product={_id:productId,name:"Tea",category:"Grocery",weightCalculationMethod:"BUNDLE",piecesPerBundle:10,bundleWeightGrams:1000,packetPrice:42,stockPackets:3,imageUrl:""};
  const customer={_id:"customer-id",customerName:"Customer",phone:"9876543210",deliveryAddress:"12 Sample Road",pincode:"781001",district:"Old district",state:"Old state"};
  const business={_id:"business-id",name:"Store",pincode:"600000",city:"Chennai",state:"Tamil Nadu",deliveryRates:{},deliveryRegions:[],paymentMethod:"OFF"};
  let savedOrder;
  t.mock.method(globalThis,"fetch",async url=>{
    const pincode=String(url).split("/").pop();
    const address=pincode==="781001"?{District:"Kamrup Metropolitan",State:"Assam"}:{District:"Chennai",State:"Tamil Nadu"};
    return new Response(JSON.stringify([{Status:"Success",PostOffice:[{Pincode:pincode,...address,Country:"India"}]}]),{status:200,headers:{"Content-Type":"application/json"}});
  });
  t.mock.method(Business,"findOne",async()=>business);
  t.mock.method(Product,"find",()=>({lean:async()=>[product]}));
  t.mock.method(Product,"findOneAndUpdate",async()=>product);
  t.mock.method(Order,"create",async order=>{savedOrder=order;return {_id:"order-id",...order};});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await createCustomerOrder({customer,params:{slug:"store"},body:{items:[{productId,packetQuantity:1}]}},res);

  assert.equal(res.statusCode,201);
  assert.equal(savedOrder.deliveryState,"Assam");
  assert.equal(savedOrder.deliveryFeePending,true);
  assert.equal(savedOrder.billSnapshot,null);
  assert.equal(savedOrder.totalInr,42);
});

test("enforces the configured minimum order weight with quantity-based customer copy",async t=>{
  const productId="aaaaaaaaaaaaaaaaaaaaaaaa";
  const product={_id:productId,name:"Tea",category:"Grocery",weightCalculationMethod:"BUNDLE",piecesPerBundle:10,bundleWeightGrams:1000,packetPrice:42,stockPackets:3,imageUrl:""};
  const customer={_id:"customer-id",customerName:"Customer",phone:"9876543210",deliveryAddress:"12 Main Road",pincode:"110001",district:"New Delhi",state:"Delhi"};
  const business={_id:"business-id",name:"Store",pincode:"380001",city:"Ahmedabad",state:"Gujarat",minimumOrderWeightGrams:2000,minimumOrderDisplayMode:"QUANTITY"};
  let stockReserved=false;
  t.mock.method(globalThis,"fetch",async url=>{
    const pincode=String(url).split("/").pop();
    return new Response(JSON.stringify([{Status:"Success",PostOffice:[{Pincode:pincode,District:"New Delhi",State:"Delhi",Country:"India"}]}]),{status:200,headers:{"Content-Type":"application/json"}});
  });
  t.mock.method(Business,"findOne",async()=>business);
  t.mock.method(Product,"find",()=>({lean:async()=>[product]}));
  t.mock.method(Product,"findOneAndUpdate",async()=>{stockReserved=true;return product;});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await createCustomerOrder({customer,params:{slug:"store"},body:{items:[{productId,packetQuantity:1}]}},res);

  assert.equal(res.statusCode,400);
  assert.equal(res.body.minimumOrderWeightGrams,2000);
  assert.equal(res.body.minimumAdditionalUnits,1);
  assert.match(res.body.message,/Add at least 1 more unit/);
  assert.equal(stockReserved,false);
});

test("business current orders exclude rejected and archived orders",async t=>{
  const query={sort(value){this.sortValue=value;return this;},limit(value){this.limitValue=value;return this;},lean:async()=>[]};
  t.mock.method(Order,"find",filter=>{
    assert.deepEqual(filter,{businessId:"business-id",businessArchivedAt:null,status:{$in:["PLACED","ACCEPTED"]}});
    return query;
  });
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await listBusinessOrders({tenantId:"business-id",query:{archived:"false"}},res);

  assert.deepEqual(query.sortValue,{createdAt:-1});
  assert.equal(res.body.orders.length,0);
});

test("business order detail is scoped to its tenant",async t=>{
  const order={_id:"507f1f77bcf86cd799439011",businessId:"business-id",orderNumber:"XW-123",items:[],toObject(){return {...this,customerAccessTokenHash:"private",customerId:"customer-id"};}};
  let filter;
  t.mock.method(Order,"findOne",async value=>{filter=value;return order;});
  const response={json(payload){this.payload=payload;return this;},status(code){this.statusCode=code;return this;}};

  await getBusinessOrder({params:{id:order._id},tenantId:"business-id"},response);

  assert.deepEqual(filter,{_id:order._id,businessId:"business-id"});
  assert.equal(response.payload.order.orderNumber,"XW-123");
  assert.equal(response.payload.order.customerAccessTokenHash,undefined);
  assert.equal(response.payload.order.customerId,undefined);
});

test("business history includes rejected and archived orders",async t=>{
  const query={sort(){return this;},limit(){return this;},lean:async()=>[]};
  t.mock.method(Order,"find",filter=>{
    assert.deepEqual(filter,{businessId:"business-id",$or:[{businessArchivedAt:{$ne:null}},{status:{$in:["REJECTED","CANCELLED","DELIVERED"]}}]});
    return query;
  });
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await listBusinessOrders({tenantId:"business-id",query:{archived:"true"}},res);

  assert.deepEqual(res.body,{orders:[]});
});

test("customer order history separates current and past orders",async t=>{
  const businessQuery={select:async()=>({_id:"business-id"})};
  const query={select(value){this.selectValue=value;return this;},populate(){return this;},sort(value){this.sortValue=value;return this;},skip(){return this;},limit(){return this;},lean:async()=>[{_id:"order-id",unreadCustomerOrderUpdates:2,billSnapshot:{sentAt:"2026-01-01"}}]};
  let requestedFilter;
  t.mock.method(Business,"findOne",()=>businessQuery);
  t.mock.method(Order,"find",filter=>{requestedFilter=filter;return query;});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await listCustomerOrders({params:{slug:"store"},customer:{_id:"customer-id"},query:{view:"current"}},res);
  assert.deepEqual(requestedFilter,{customerId:"customer-id",businessId:"business-id",customerArchivedAt:null,businessArchivedAt:null,status:{$in:["PLACED","ACCEPTED"]}});
  assert.deepEqual(query.sortValue,{"billSnapshot.sentAt":-1,createdAt:-1});
  assert.match(query.selectValue,/unreadCustomerOrderUpdates/);
  assert.equal(res.body.orders[0].unreadUpdateCount,2);
  assert.equal(res.body.orders[0].billSentAt,"2026-01-01");

  await listCustomerOrders({params:{slug:"store"},customer:{_id:"customer-id"},query:{view:"history"}},res);
  assert.deepEqual(requestedFilter,{customerId:"customer-id",businessId:"business-id",customerArchivedAt:null,$or:[{businessArchivedAt:{$ne:null}},{status:{$in:["REJECTED","CANCELLED","DELIVERED"]}}]});
  assert.deepEqual(query.sortValue,{createdAt:-1});
});
