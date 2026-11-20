import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {z} from "zod";
import Business from "../models/Business.js";
import Order from "../models/Order.js";
import SupportConversation from "../models/SupportConversation.js";

const categorySchema=z.enum(["SUBSCRIPTION","PAYMENT","STORE","TECHNICAL","OTHER"]);
const broadcastSchema=z.object({
  scope:z.enum(["ALL","SELECTED"]),
  businessIds:z.array(z.string().refine(mongoose.isValidObjectId)).max(100).default([]),
  subject:z.string().trim().min(3).max(120),
  category:categorySchema,
  body:z.string().trim().min(2).max(2000),
  important:z.boolean().optional().default(false)
}).superRefine((value,ctx)=>{
  if(value.scope==="SELECTED"&&!value.businessIds.length){
    ctx.addIssue({code:"custom",message:"Select at least one business for this message.",path:["businessIds"]});
  }
});

function firstIssue(error){
  return error.issues?.[0]?.message||"Please check the message details.";
}

export async function getBusinessInboxCounts(req,res){
  const [pendingOrders,unreadAlerts]=await Promise.all([
    Order.countDocuments({businessId:req.tenantId,businessArchivedAt:null,status:"PLACED"}),
    SupportConversation.countDocuments({businessId:req.tenantId,broadcastId:{$ne:""},unreadForBusiness:true})
  ]);
  res.json({pendingOrders,unreadAlerts});
}

export async function listBusinessNotifications(req,res){
  const notifications=await SupportConversation.find({businessId:req.tenantId,broadcastId:{$ne:""}})
    .sort({createdAt:-1})
    .limit(100)
    .lean();
  res.json({notifications});
}

export async function markBusinessNotificationRead(req,res){
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:"Invalid notification ID."});
  const notification=await SupportConversation.findOneAndUpdate(
    {_id:req.params.id,businessId:req.tenantId,broadcastId:{$ne:""}},
    {$set:{unreadForBusiness:false}},
    {new:true}
  );
  if(!notification)return res.status(404).json({message:"Notification not found in your business workspace."});
  res.json({notification});
}

export async function getCustomerInboxCounts(req,res){
  const business=await Business.findOne({slug:req.params.slug,status:"ACTIVE"}).select("_id");
  if(!business)return res.status(404).json({message:"This store is not available."});
  const unreadOrders=await Order.find({businessId:business._id,customerId:req.customer._id,customerArchivedAt:null,unreadCustomerOrderUpdates:{$gt:0}}).select("unreadCustomerOrderUpdates").lean();
  const unreadOrderUpdates=unreadOrders.reduce((total,order)=>total+(order.unreadCustomerOrderUpdates||0),0);
  res.json({unreadOrderUpdates});
}

export async function listSupportBusinesses(req,res){
  const businesses=await Business.find({status:"ACTIVE"}).select("_id name slug").sort({name:1}).lean();
  res.json({businesses});
}

export async function broadcastToBusinesses(req,res){
  const parsed=broadcastSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:firstIssue(parsed.error)});
  const businessFilter=parsed.data.scope==="ALL"
    ?{status:"ACTIVE"}
    :{_id:{$in:[...new Set(parsed.data.businessIds)]},status:"ACTIVE"};
  const businesses=await Business.find(businessFilter).select("_id").lean();
  if(!businesses.length)return res.status(404).json({message:"No active businesses matched this message."});
  if(parsed.data.scope==="SELECTED"&&businesses.length!==new Set(parsed.data.businessIds).size){
    return res.status(400).json({message:"One or more selected businesses are not active."});
  }
  const broadcastId=randomUUID();
  const now=new Date();
  const conversations=businesses.map(({_id})=>({
    businessId:_id,
    subject:parsed.data.subject,
    category:parsed.data.category,
    status:"OPEN",
    broadcastId,
    messages:[{senderId:req.user._id,senderRole:"SUPER_ADMIN",body:parsed.data.body,important:parsed.data.important,createdAt:now}],
    lastMessageAt:now,
    unreadForBusiness:true,
    unreadForSuperAdmin:false
  }));
  await SupportConversation.insertMany(conversations);
  res.status(201).json({message:`Message delivered to ${businesses.length} business${businesses.length===1?"":"es"}.`,recipientCount:businesses.length,broadcastId});
}
