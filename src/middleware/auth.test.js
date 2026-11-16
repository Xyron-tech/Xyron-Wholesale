import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {mock,test} from "node:test";
import User from "../models/User.js";
import {env} from "../config/env.js";
import {requireAuth} from "./auth.js";

test("password reset invalidates existing business-admin sessions",async()=>{
  const token=jwt.sign({sub:"000000000000000000000001",sessionVersion:2},env.JWT_SECRET,{expiresIn:"1h"});
  const findUser=mock.method(User,"findById",async()=>({accountStatus:"ACTIVE",sessionVersion:3}));
  const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  let continued=false;
  try{
    await requireAuth({cookies:{xyron_session:token}},response,()=>{continued=true;});
    assert.equal(response.statusCode,401);
    assert.equal(continued,false);
  }finally{
    findUser.mock.restore();
  }
});

test("sessions created before session-version tracking remain valid",async()=>{
  const token=jwt.sign({sub:"000000000000000000000001"},env.JWT_SECRET,{expiresIn:"1h"});
  const user={accountStatus:"ACTIVE",sessionVersion:0};
  const findUser=mock.method(User,"findById",async()=>user);
  const response={status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  let continued=false;
  try{
    await requireAuth({cookies:{xyron_session:token}},response,()=>{continued=true;});
    assert.equal(continued,true);
  }finally{
    findUser.mock.restore();
  }
});
