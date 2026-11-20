import assert from "node:assert/strict";
import {mock,test} from "node:test";
import Business from "../models/Business.js";
import BusinessApplication from "../models/BusinessApplication.js";
import User from "../models/User.js";
import {registerBusiness} from "./authController.js";

test("business registration rejects a mismatched password confirmation",async()=>{
  const exists=mock.method(User,"exists",async()=>false);
  const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  try{
    await registerBusiness({body:{
      ownerName:"Store Owner",
      email:"owner@example.com",
      phone:"9876543210",
      password:"password-one",
      confirmPassword:"password-two",
      businessName:"Sample Store",
      category:"Grocery",
      address:"12 Sample Road",
      city:"Chennai",
      state:"Tamil Nadu",
      pincode:"600001",
      selectedPlan:"STARTER"
    }},response);
    assert.equal(response.statusCode,400);
    assert.equal(response.body.message,"Passwords do not match.");
    assert.equal(exists.mock.calls.length,0);
  }finally{
    exists.mock.restore();
  }
});

test("business registration saves optional per-kg delivery rates",async t=>{
  const createdBusiness={_id:"507f1f77bcf86cd799439012"};
  const createdUser={_id:"507f1f77bcf86cd799439013",async save(){}};
  let businessDetails;
  t.mock.method(User,"exists",async()=>false);
  t.mock.method(Business,"exists",async()=>false);
  t.mock.method(User,"create",async()=>createdUser);
  t.mock.method(Business,"create",async details=>{businessDetails=details;return createdBusiness;});
  t.mock.method(BusinessApplication,"create",async()=>({}));
  const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await registerBusiness({body:{
    ownerName:"Store Owner",
    email:"owner@example.com",
    phone:"9876543210",
    password:"correct-password",
    confirmPassword:"correct-password",
    businessName:"Sample Store",
    category:"Grocery",
    address:"12 Sample Road",
    city:"Chennai",
    state:"Tamil Nadu",
    pincode:"600001",
    localRatePerKg:"12.50",
    sameDistrictRatePerKg:"20",
    sameStateRatePerKg:"35",
    otherStateRatePerKg:"60",
    selectedPlan:"STARTER"
  }},response);

  assert.equal(response.statusCode,201);
  assert.equal(businessDetails.contactPhone,"9876543210");
  assert.deepEqual(businessDetails.deliveryRates,{
    localPaisa:1250,
    sameDistrictPaisa:2000,
    sameStatePaisa:3500,
    otherStatePaisa:6000
  });
});
