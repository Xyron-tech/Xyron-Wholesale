import assert from "node:assert/strict";
import {mock,test} from "node:test";
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
