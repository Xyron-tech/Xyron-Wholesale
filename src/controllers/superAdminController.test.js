import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {mock,test} from "node:test";
import Business from "../models/Business.js";
import BusinessApplication from "../models/BusinessApplication.js";
import User from "../models/User.js";
import {updateBusinessAdminPassword,updateBusinessPlan} from "./superAdminController.js";

test("Super Admin can enable and disable analytics for an active Pro business",async()=>{
  const business={
    _id:"000000000000000000000001",
    status:"ACTIVE",
    subscriptionPlan:"PRO",
    subscriptionFeatures:{advancedSeo:false,quickReplies:false,analytics:false},
    async save(){},
    markModified(){}
  };
  const findBusiness=mock.method(Business,"findById",async()=>business);
  const updateApplication=mock.method(BusinessApplication,"updateOne",async()=>({}));
  const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  try{
    await updateBusinessPlan({params:{id:business._id},body:{plan:"PRO",features:{analytics:true}}},response);
    assert.equal(response.statusCode,200);
    assert.equal(response.body.business.subscriptionFeatures.analytics,true);
    await updateBusinessPlan({params:{id:business._id},body:{plan:"PRO",features:{analytics:false}}},response);
    assert.equal(response.body.business.subscriptionFeatures.analytics,false);
  }finally{
    findBusiness.mock.restore();
    updateApplication.mock.restore();
  }
});

test("Super Admin password updates hash the new password and revoke old sessions",async()=>{
  const businessId="000000000000000000000001";
  const owner={
    _id:"000000000000000000000002",
    role:"BUSINESS_OWNER",
    passwordHash:"old-hash",
    sessionVersion:2,
    async save(){}
  };
  const findBusiness=mock.method(Business,"findById",async()=>({status:"ACTIVE",ownerId:owner._id}));
  const findUser=mock.method(User,"findById",()=>({select:async()=>owner}));
  const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  try{
    await updateBusinessAdminPassword({params:{id:businessId},body:{password:"a-new-admin-password",confirmPassword:"a-new-admin-password"}},response);
    assert.equal(response.statusCode,200);
    assert.equal(await bcrypt.compare("a-new-admin-password",owner.passwordHash),true);
    assert.equal(owner.sessionVersion,3);
    assert.match(response.body.message,/signed out/);
  }finally{
    findBusiness.mock.restore();
    findUser.mock.restore();
  }
});

test("Super Admin password update rejects mismatched confirmation",async()=>{
  const findBusiness=mock.method(Business,"findById",async()=>({status:"ACTIVE"}));
  const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  try{
    await updateBusinessAdminPassword({params:{id:"000000000000000000000001"},body:{password:"a-new-admin-password",confirmPassword:"different-password"}},response);
    assert.equal(response.statusCode,400);
    assert.equal(response.body.message,"Passwords do not match.");
    assert.equal(findBusiness.mock.calls.length,0);
  }finally{
    findBusiness.mock.restore();
  }
});
