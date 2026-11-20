import assert from "node:assert/strict";
import {test} from "node:test";
import Business from "../models/Business.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import {getPublicProducts,setProductFeatured,updatePaymentSettings,updateShippingSettings,updateStoreProfile,updateStoreSections} from "./storeController.js";

test("saves storefront sections containing active products from the business",async t=>{
  const productId="507f1f77bcf86cd799439011";
  const business={
    _id:"507f1f77bcf86cd799439012",
    ownerId:"507f1f77bcf86cd799439013",
    slug:"test-store",
    status:"ACTIVE",
    subscriptionPlan:"STARTER",
    async save(){}
  };
  t.mock.method(Business,"findOne",async()=>business);
  t.mock.method(Product,"find",() => ({
    select(){return this;},
    async lean(){return [{_id:productId}];}
  }));
  const response={
    statusCode:200,
    status(code){this.statusCode=code;return this;},
    json(payload){this.payload=payload;return this;}
  };

  await updateStoreSections({
    tenantId:business._id,
    user:{_id:business.ownerId},
    body:{sections:[{title:"Best sellers",productIds:[productId]}]}
  },response);

  assert.equal(response.statusCode,200);
  assert.equal(response.payload.message,"Store sections saved.");
  assert.equal(response.payload.business.storeSections[0].title,"Best sellers");
});

test("sets a product favorite only within the authenticated business",async t=>{
  const productId="507f1f77bcf86cd799439011";
  const businessId="507f1f77bcf86cd799439012";
  const ownerId="507f1f77bcf86cd799439013";
  const product={_id:productId,isFeatured:false,async save(){}};
  t.mock.method(Business,"findOne",async()=>({_id:businessId,ownerId,slug:"test-store",status:"ACTIVE"}));
  t.mock.method(Product,"findOne",async filter=>{
    assert.deepEqual(filter,{_id:productId,businessId});
    return product;
  });
  const response={
    statusCode:200,
    status(code){this.statusCode=code;return this;},
    json(payload){this.payload=payload;return this;}
  };

  await setProductFeatured({
    params:{id:productId},
    tenantId:businessId,
    user:{_id:ownerId},
    body:{isFeatured:true}
  },response);

  assert.equal(response.statusCode,200);
  assert.equal(response.payload.product.isFeatured,true);
  assert.equal(response.payload.message,"Product added to storefront favorites.");
});

test("public product filtering can return storefront favorites only",async t=>{
  const businessId="507f1f77bcf86cd799439012";
  let queriedFilter;
  t.mock.method(Business,"findOne",()=>({select:async()=>({_id:businessId})}));
  t.mock.method(Product,"find",filter=>{
    queriedFilter=filter;
    return {
      select(){return this;},
      sort(){return this;},
      limit(){return this;},
      async lean(){return [];}
    };
  });
  t.mock.method(Product,"distinct",async()=>[]);
  const response={json(payload){this.payload=payload;return this;}};

  await getPublicProducts({params:{slug:"test-store"},query:{featuredOnly:"true"}},response);

  assert.deepEqual(queriedFilter,{businessId,status:"ACTIVE",isFeatured:true});
  assert.deepEqual(response.payload.products,[]);
});

test("enabling a payment method alerts customers with unpaid open orders",async t=>{
  const business={
    _id:"507f1f77bcf86cd799439012",
    ownerId:"507f1f77bcf86cd799439013",
    slug:"test-store",
    status:"ACTIVE",
    subscriptionPlan:"STARTER",
    paymentMethod:"OFF",
    paymentQrEnabled:false,
    deliveryRegions:[],
    sliderSlides:[],
    async save(){}
  };
  let alertFilter,alertUpdate;
  t.mock.method(Business,"findOne",async()=>business);
  t.mock.method(Order,"updateMany",async(filter,update)=>{alertFilter=filter;alertUpdate=update;return {modifiedCount:2};});
  const response={
    statusCode:200,
    status(code){this.statusCode=code;return this;},
    json(payload){this.payload=payload;return this;}
  };

  await updatePaymentSettings({
    tenantId:business._id,
    user:{_id:business.ownerId},
    body:{paymentMethod:"GPAY",upiId:"store@example",paymentInstructions:"Pay with order number"}
  },response);

  assert.equal(response.statusCode,200);
  assert.deepEqual(alertFilter,{
    businessId:business._id,
    customerId:{$ne:null},
    businessArchivedAt:null,
    customerArchivedAt:null,
    status:{$in:["PLACED","ACCEPTED"]},
    paymentStatus:{$in:["UNPAID","REJECTED"]}
  });
  assert.equal(alertUpdate.$inc.unreadCustomerOrderUpdates,1);
  assert.equal(alertUpdate.$set.paymentInfoSnapshot.upiIdSnapshot,"store@example");
  assert.match(response.payload.message,/sent to 2 open orders/);
});

test("requires a saved or uploaded QR before enabling QR payments",async t=>{
  const business={
    _id:"507f1f77bcf86cd799439012",
    ownerId:"507f1f77bcf86cd799439013",
    slug:"test-store",
    status:"ACTIVE",
    subscriptionPlan:"STARTER",
    paymentMethod:"OFF",
    paymentQrEnabled:false,
    paymentQrUrl:"",
    deliveryRegions:[],
    sliderSlides:[],
    async save(){}
  };
  t.mock.method(Business,"findOne",async()=>business);
  const response={
    statusCode:200,
    status(code){this.statusCode=code;return this;},
    json(payload){this.payload=payload;return this;}
  };

  await updatePaymentSettings({
    tenantId:business._id,
    user:{_id:business.ownerId},
    body:{paymentMethod:"QR"}
  },response);

  assert.equal(response.statusCode,400);
  assert.match(response.payload.message,/Upload a payment QR/);
});

test("saves default rates and a future PIN-specific delivery override",async t=>{
  const business={
    _id:"507f1f77bcf86cd799439012",
    ownerId:"507f1f77bcf86cd799439013",
    slug:"test-store",
    status:"ACTIVE",
    subscriptionPlan:"STARTER",
    deliveryRates:{},
    deliveryRegions:[],
    sliderSlides:[],
    async save(){}
  };
  t.mock.method(Business,"findOne",async()=>business);
  const response={
    statusCode:200,
    status(code){this.statusCode=code;return this;},
    json(payload){this.payload=payload;return this;}
  };

  await updateShippingSettings({
    tenantId:business._id,
    user:{_id:business.ownerId},
    body:{
      deliveryRates:{localPaisa:1000,sameDistrictPaisa:2000,sameStatePaisa:3000,otherStatePaisa:4000},
      deliveryRegions:[{name:"New city PIN",matchType:"PINCODE",pincode:"613001",ratePerKgPaisa:5500}]
    }
  },response);

  assert.equal(response.statusCode,200);
  assert.equal(response.payload.business.deliveryRates.otherStatePaisa,4000);
  assert.equal(response.payload.business.deliveryRegions[0].pincode,"613001");
  assert.equal(response.payload.business.deliveryRegions[0].matchType,"PINCODE");
});

test("saves the configurable minimum weight and customer messaging in the store profile",async t=>{
  const business={
    _id:"507f1f77bcf86cd799439012",
    ownerId:"507f1f77bcf86cd799439013",
    slug:"test-store",
    name:"Sample Store",
    category:"Grocery",
    status:"ACTIVE",
    subscriptionPlan:"STARTER",
    subscriptionFeatures:{},
    minimumOrderWeightGrams:1000,
    minimumOrderDisplayMode:"WEIGHT",
    async save(){}
  };
  t.mock.method(Business,"findOne",async()=>business);
  const response={
    statusCode:200,
    status(code){this.statusCode=code;return this;},
    json(payload){this.payload=payload;return this;}
  };

  await updateStoreProfile({
    tenantId:business._id,
    user:{_id:business.ownerId},
    body:{
      name:"Sample Store",
      category:"Grocery",
      description:"",
      minimumOrderWeightGrams:2500,
      minimumOrderDisplayMode:"QUANTITY",
      minimumOrderQuantityMessage:"Add {remainingUnits} more units.",
      minimumOrderWeightMessage:"Add {remainingWeight}.",
      minimumOrderSliderText:"Minimum purchase: {minimumWeight}"
    }
  },response);

  assert.equal(response.statusCode,200);
  assert.equal(response.payload.business.minimumOrderWeightGrams,2500);
  assert.equal(response.payload.business.minimumOrderDisplayMode,"QUANTITY");
  assert.equal(response.payload.business.minimumOrderSliderText,"Minimum purchase: {minimumWeight}");
});
