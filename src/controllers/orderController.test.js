import assert from "node:assert/strict";
import {mock,test} from "node:test";
import Business from "../models/Business.js";
import Order from "../models/Order.js";
import OrderMessage from "../models/OrderMessage.js";
import {getBusinessOrderMessages,markBusinessOrderMessagesRead,markCustomerOrderMessagesRead,sendBusinessOrderBill,updateBusinessOrderStatus} from "./orderController.js";

test("accepting an order sends a customer chat update and increments its unread count",async t=>{
  const order={_id:"order-id",businessId:"business-id",status:"PLACED",toObject(){return {...this};}};
  let createdMessage;
  let unreadUpdate;
  t.mock.method(Order,"findOne",async()=>order);
  t.mock.method(Order,"findOneAndUpdate",async()=>({...order,status:"ACCEPTED"}));
  t.mock.method(OrderMessage,"exists",async()=>null);
  t.mock.method(OrderMessage,"create",async message=>{createdMessage=message;return message;});
  t.mock.method(Order,"updateOne",async(...args)=>{unreadUpdate=args;return {matchedCount:1};});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await updateBusinessOrderStatus({params:{id:"order-id"},tenantId:"business-id",user:{name:"Store owner"},body:{status:"ACCEPTED"}},res);

  assert.equal(res.statusCode,200);
  assert.equal(createdMessage.senderRole,"BUSINESS_OWNER");
  assert.equal(createdMessage.eventKey,"ORDER_ACCEPTED");
  assert.match(createdMessage.body,/accepted/i);
  assert.deepEqual(unreadUpdate[1],{$inc:{unreadCustomerMessages:1}});
});

test("polling order chat does not clear unread message counts",async t=>{
  const order={_id:"order-id",businessId:"business-id",unreadBusinessMessages:2};
  let unreadWasCleared=false;
  const messages=[{_id:"message-id",body:"A new message"}];
  const query={sort(){return this;},limit(){return this;},lean:async()=>messages};
  t.mock.method(Order,"findOne",async()=>order);
  t.mock.method(OrderMessage,"find",()=>query);
  t.mock.method(Order,"updateOne",async()=>{unreadWasCleared=true;});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await getBusinessOrderMessages({params:{id:"order-id"},tenantId:"business-id"},res);

  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body.messages,messages);
  assert.equal(unreadWasCleared,false);
});

test("business chat marks unread messages read only through the latest loaded message",async t=>{
  const throughMessageId="aaaaaaaaaaaaaaaaaaaaaaaa";
  const order={_id:"order-id",businessId:"business-id",unreadBusinessMessages:2};
  let update;
  const query={sort(){return this;},select(){return this;},lean:async()=>({_id:throughMessageId})};
  t.mock.method(Order,"findOne",async()=>order);
  t.mock.method(OrderMessage,"findOne",()=>query);
  t.mock.method(Order,"updateOne",async(...args)=>{update=args;return {modifiedCount:1};});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await markBusinessOrderMessagesRead({params:{id:"order-id"},tenantId:"business-id",body:{throughMessageId}},res);

  assert.deepEqual(update[0],{_id:"order-id",businessId:"business-id",unreadBusinessMessages:2});
  assert.deepEqual(update[1],{$set:{unreadBusinessMessages:0}});
  assert.deepEqual(res.body,{markedRead:true});
});

test("customer chat marks the customer's unread counter read",async t=>{
  const throughMessageId="cccccccccccccccccccccccc";
  const order={_id:"order-id",businessId:"business-id",customerId:"customer-id",unreadCustomerMessages:3};
  let update;
  const businessQuery={select:async()=>({_id:"business-id"})};
  const orderQuery={select:async()=>order};
  const latestMessageQuery={sort(){return this;},select(){return this;},lean:async()=>({_id:throughMessageId})};
  t.mock.method(Business,"findOne",()=>businessQuery);
  t.mock.method(Order,"findOne",()=>orderQuery);
  t.mock.method(OrderMessage,"findOne",()=>latestMessageQuery);
  t.mock.method(Order,"updateOne",async(...args)=>{update=args;return {modifiedCount:1};});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await markCustomerOrderMessagesRead({
    params:{slug:"store",orderNumber:"order-number"},
    customer:{_id:"customer-id"},
    body:{throughMessageId}
  },res);

  assert.deepEqual(update[0],{_id:"order-id",businessId:"business-id",unreadCustomerMessages:3});
  assert.deepEqual(update[1],{$set:{unreadCustomerMessages:0}});
  assert.deepEqual(res.body,{markedRead:true});
});

test("a bill sent with QR payments disabled does not include QR payment details",async t=>{
  const regionId="bbbbbbbbbbbbbbbbbbbbbbbb";
  const order={_id:"order-id",businessId:"business-id",status:"ACCEPTED",billSnapshot:null,totalWeightGrams:1000,subtotalInr:42,items:[{name:"Tea",packetQuantity:2,unitLabel:"bundle",packetPrice:21,lineTotal:42}]};
  const business={name:"Store",paymentQrEnabled:false,paymentQrUrl:"https://example.test/qr.png",paymentQrPublicId:"qr-id",upiId:"store@example",paymentInstructions:"Pay the bill",deliveryRegions:[{_id:regionId,name:"Local",ratePerKgPaisa:10000}]};
  let billUpdate;
  t.mock.method(Order,"findOne",async()=>order);
  t.mock.method(Business,"findOne",()=>({select:async()=>business}));
  t.mock.method(Order,"findOneAndUpdate",async(_filter,update)=>{billUpdate=update.$set;return {...order,...billUpdate};});
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};

  await sendBusinessOrderBill({params:{id:"order-id"},tenantId:"business-id",body:{regionId,deliveryChargePaisa:1000}},res);

  assert.equal(res.statusCode,200);
  assert.equal(billUpdate.billSnapshot.paymentQrSnapshot,"");
  assert.equal(billUpdate.billSnapshot.upiIdSnapshot,"");
  assert.equal(billUpdate.billSnapshot.paymentInstructionsSnapshot,"");
  assert.equal(billUpdate.paymentQrSnapshot,"");
});
