import assert from "node:assert/strict";
import {mock,test} from "node:test";
import Business from "../models/Business.js";
import BusinessApplication from "../models/BusinessApplication.js";
import PlanUpgradeRequest from "../models/PlanUpgradeRequest.js";
import {
  createBusinessPlanUpgradeRequest,
  listSuperAdminPlanUpgradeRequests,
  reviewPlanUpgradeRequest
} from "./planUpgradeController.js";

const businessId="000000000000000000000001";
const requestId="000000000000000000000002";
const adminId="000000000000000000000003";

function response(){
  return {statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
}

test("active business owners can submit a plan request with an optional note",async t=>{
  const business={_id:businessId};
  const request={_id:requestId,businessId,ownerId:"owner-id",requestedPlan:"GROWTH",note:"Need more products",status:"PENDING"};
  t.mock.method(Business,"findOne",filter=>{
    assert.deepEqual(filter,{_id:businessId,status:"ACTIVE"});
    return {select:async()=>business};
  });
  t.mock.method(PlanUpgradeRequest,"findOne",filter=>{
    assert.deepEqual(filter,{businessId,status:"PENDING"});
    return {select(){return this;},lean:async()=>null};
  });
  t.mock.method(PlanUpgradeRequest,"create",async values=>{
    assert.deepEqual(values,{businessId,ownerId:"owner-id",requestedPlan:"GROWTH",note:"Need more products"});
    return request;
  });
  const res=response();

  await createBusinessPlanUpgradeRequest({
    tenantId:businessId,
    user:{_id:"owner-id"},
    body:{plan:"GROWTH",note:"  Need more products  "}
  },res);

  assert.equal(res.statusCode,201);
  assert.equal(res.body.request,request);
  assert.match(res.body.message,/sent to Xyron Admin/);
});

test("business owners cannot create a second pending plan request",async t=>{
  t.mock.method(Business,"findOne",()=>({select:async()=>({_id:businessId})}));
  t.mock.method(PlanUpgradeRequest,"findOne",()=>({select(){return this;},lean:async()=>({_id:requestId})}));
  const createRequest=t.mock.method(PlanUpgradeRequest,"create",async()=>{throw new Error("must not create");});
  const res=response();

  await createBusinessPlanUpgradeRequest({tenantId:businessId,user:{_id:"owner-id"},body:{plan:"PRO"}},res);

  assert.equal(res.statusCode,409);
  assert.match(res.body.message,/already has a pending plan request/);
  assert.equal(createRequest.mock.callCount(),0);
});

test("Super Admin receives plan upgrade requests with populated business details",async t=>{
  const requests=[{_id:requestId}];
  t.mock.method(PlanUpgradeRequest,"find",()=>({
    populate(field,projection){assert.equal(field,"businessId");assert.match(projection,/subscriptionPlan/);return this;},
    sort(value){assert.deepEqual(value,{createdAt:-1});return this;},
    limit(value){assert.equal(value,300);return this;},
    lean:async()=>requests
  }));
  const res=response();

  await listSuperAdminPlanUpgradeRequests({},res);

  assert.deepEqual(res.body,{requests});
});

test("Super Admin approval activates the requested plan and its default features",async t=>{
  const upgradeRequest={
    _id:requestId,
    businessId,
    requestedPlan:"PRO",
    status:"PENDING"
  };
  const business={
    _id:businessId,
    status:"ACTIVE",
    subscriptionPlan:"STARTER",
    subscriptionFeatures:{analytics:false},
    markModified(path){this.modifiedPath=path;},
    async save(){this.saved=true;}
  };
  t.mock.method(PlanUpgradeRequest,"findById",async()=>upgradeRequest);
  t.mock.method(PlanUpgradeRequest,"findOneAndUpdate",async(filter,update)=>{
    assert.deepEqual(filter,{_id:requestId,status:"PENDING"});
    assert.equal(update.$set.status,"APPROVED");
    return {...upgradeRequest,...update.$set};
  });
  t.mock.method(Business,"findById",async()=>business);
  t.mock.method(BusinessApplication,"updateOne",async(filter,update)=>{
    assert.deepEqual(filter,{businessId});
    assert.equal(update.$set.selectedPlan,"PRO");
  });
  const res=response();

  await reviewPlanUpgradeRequest({params:{id:requestId},body:{decision:"APPROVED"},user:{_id:adminId}},res);

  assert.equal(res.statusCode,200);
  assert.equal(business.subscriptionPlan,"PRO");
  assert.deepEqual(business.subscriptionFeatures,{advancedSeo:true,quickReplies:true,analytics:true});
  assert.equal(business.modifiedPath,"subscriptionFeatures");
  assert.equal(business.saved,true);
  assert.ok(business.subscriptionActivatedAt instanceof Date);
  assert.match(res.body.message,/approved and plan features activated/);
});

test("Super Admin rejection records a decision without changing the business plan",async t=>{
  const upgradeRequest={_id:requestId,businessId,requestedPlan:"GROWTH",status:"PENDING"};
  t.mock.method(PlanUpgradeRequest,"findById",async()=>upgradeRequest);
  t.mock.method(PlanUpgradeRequest,"findOneAndUpdate",async(filter,update)=>({...upgradeRequest,...update.$set}));
  const findBusiness=t.mock.method(Business,"findById",async()=>{throw new Error("rejection must not change the business");});
  const res=response();

  await reviewPlanUpgradeRequest({params:{id:requestId},body:{decision:"REJECTED"},user:{_id:adminId}},res);

  assert.equal(res.statusCode,200);
  assert.match(res.body.message,/rejected/);
  assert.equal(findBusiness.mock.callCount(),0);
});
