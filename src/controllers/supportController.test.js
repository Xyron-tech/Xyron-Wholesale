import assert from "node:assert/strict";
import {mock,test} from "node:test";
import Business from "../models/Business.js";
import Order from "../models/Order.js";
import SupportConversation from "../models/SupportConversation.js";
import {getBusinessInboxCounts,getCustomerInboxCounts,markBusinessNotificationRead} from "./supportController.js";

function response(){
  return {statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
}

test("business inbox counts include only unread super-admin alerts",async t=>{
  t.mock.method(Order,"countDocuments",async filter=>filter.status==="PLACED"?2:0);
  t.mock.method(SupportConversation,"countDocuments",async filter=>{
    assert.deepEqual(filter,{businessId:"business-id",broadcastId:{$ne:""},unreadForBusiness:true});
    return 3;
  });
  const res=response();

  await getBusinessInboxCounts({tenantId:"business-id"},res);

  assert.deepEqual(res.body,{pendingOrders:2,unreadAlerts:3});
});

test("customer inbox counts are scoped to unread order alerts for the signed-in customer and store",async t=>{
  const businessQuery={select:async()=>({_id:"business-id"})};
  t.mock.method(Business,"findOne",filter=>{
    assert.deepEqual(filter,{slug:"test-store",status:"ACTIVE"});
    return businessQuery;
  });
  t.mock.method(Order,"find",filter=>{
    assert.deepEqual(filter,{businessId:"business-id",customerId:"customer-id",customerArchivedAt:null,unreadCustomerOrderUpdates:{$gt:0}});
    return {select(){return this;},async lean(){return [{unreadCustomerOrderUpdates:1},{unreadCustomerOrderUpdates:3}];}};
  });
  const res=response();

  await getCustomerInboxCounts({params:{slug:"test-store"},customer:{_id:"customer-id"}},res);

  assert.deepEqual(res.body,{unreadOrderUpdates:4});
});

test("business alert read state can only be cleared inside its business workspace",async t=>{
  const notificationId="64a000000000000000000001";
  let update;
  t.mock.method(SupportConversation,"findOneAndUpdate",async(...args)=>{
    update=args;
    return {_id:notificationId,unreadForBusiness:false};
  });
  const res=response();

  await markBusinessNotificationRead({params:{id:notificationId},tenantId:"business-id"},res);

  assert.deepEqual(update[0],{_id:notificationId,businessId:"business-id",broadcastId:{$ne:""}});
  assert.deepEqual(update[1],{$set:{unreadForBusiness:false}});
  assert.deepEqual(res.body,{notification:{_id:notificationId,unreadForBusiness:false}});
});
