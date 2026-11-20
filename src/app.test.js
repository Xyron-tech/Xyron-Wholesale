import assert from "node:assert/strict";
import {test} from "node:test";
import mongoose from "mongoose";
import app from "./app.js";

test("the API root responds with service health instead of a missing-route 404",async t=>{
  const server=app.listen(0,"127.0.0.1");
  t.after(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  await new Promise(resolve=>server.once("listening",resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;

  const [root,api,health]=await Promise.all([
    fetch(origin),
    fetch(`${origin}/api`),
    fetch(`${origin}/api/health`)
  ]);
  const expectedStatus=mongoose.connection.readyState===1?200:503;

  assert.equal(root.status,expectedStatus);
  assert.equal(api.status,expectedStatus);
  assert.equal(health.status,expectedStatus);
  assert.equal((await root.json()).service,"xyron-wholesale-api");
  assert.equal((await health.json()).status,expectedStatus===200?"ok":"unavailable");
});
