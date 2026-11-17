import assert from "node:assert/strict";
import {mock,test} from "node:test";
import {errorHandler} from "./errors.js";

test("unexpected server errors are logged with a safe correlation reference",()=>{
  const logged=[];
  const log=mock.method(console,"error",message=>logged.push(JSON.parse(message)));
  const response={
    headers:{},
    status(code){this.statusCode=code;return this;},
    set(name,value){this.headers[name]=value;return this;},
    json(body){this.body=body;return this;}
  };
  try{
    errorHandler(new Error("database connection failed"),{method:"GET",path:"/api/orders"},response);
    assert.equal(response.statusCode,500);
    assert.equal(response.body.message,"An unexpected server error occurred. Please try again; contact support if it continues.");
    assert.match(response.body.requestId,/^[0-9a-f-]{36}$/);
    assert.equal(response.headers["X-Request-Id"],response.body.requestId);
    assert.equal(logged.length,1);
    assert.equal(logged[0].event,"api_request_failed");
    assert.equal(logged[0].path,"/api/orders");
    assert.equal(logged[0].error,"database connection failed");
    assert.equal(JSON.stringify(response.body).includes("database connection failed"),false);
  }finally{
    log.mock.restore();
  }
});

test("known server errors retain their public message and gain a reference",()=>{
  const log=mock.method(console,"error",()=>{});
  const response={
    status(code){this.statusCode=code;return this;},
    set(name,value){this.headers={[name]:value};return this;},
    json(body){this.body=body;return this;}
  };
  try{
    errorHandler(Object.assign(new Error("Service temporarily unavailable."),{status:503}),{method:"GET",path:"/api/health"},response);
    assert.equal(response.statusCode,503);
    assert.equal(response.body.message,"Service temporarily unavailable.");
    assert.equal(response.headers["X-Request-Id"],response.body.requestId);
    assert.equal(log.mock.callCount(),1);
  }finally{
    log.mock.restore();
  }
});
