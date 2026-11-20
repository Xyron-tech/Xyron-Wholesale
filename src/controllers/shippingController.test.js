import test from "node:test";
import assert from "node:assert/strict";
import {getPincodeDetails} from "./shippingController.js";

function mockResponse(){return{statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}

test("PIN lookup resolves district and state through the India Post API",async t=>{
  let requestedUrl="";
  t.mock.method(globalThis,"fetch",async url=>{
    requestedUrl=String(url);
    return new Response(JSON.stringify([{Status:"Success",PostOffice:[{Pincode:"600001",District:"Chennai",State:"Tamil Nadu",Country:"India"}]}]),{status:200,headers:{"Content-Type":"application/json"}});
  });
  const response=mockResponse();
  await getPincodeDetails({params:{pincode:"600001"}},response);
  assert.equal(response.statusCode,200);
  assert.equal(response.body.details.pincode,"600001");
  assert.equal(response.body.details.district,"Chennai");
  assert.equal(response.body.details.state,"Tamil Nadu");
  assert.equal(requestedUrl,"https://api.postalpincode.in/pincode/600001");
});

test("PIN lookup reports invalid and unknown PINs",async t=>{
  t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify([{Status:"Error",PostOffice:null}]),{status:200,headers:{"Content-Type":"application/json"}}));
  const invalid=mockResponse();
  await getPincodeDetails({params:{pincode:"12345"}},invalid);
  assert.equal(invalid.statusCode,400);
  assert.match(invalid.body.message,/valid 6-digit/);

  const unknown=mockResponse();
  await getPincodeDetails({params:{pincode:"999998"}},unknown);
  assert.equal(unknown.statusCode,404);
  assert.match(unknown.body.message,/not found by India Post/);
});
