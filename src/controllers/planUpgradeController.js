import mongoose from "mongoose";
import {z} from "zod";
import Business from "../models/Business.js";
import BusinessApplication from "../models/BusinessApplication.js";
import PlanUpgradeRequest from "../models/PlanUpgradeRequest.js";
import {getPlanFeatureDefaults} from "../utils/businessPlans.js";

const businessRequestSchema=z.object({
  plan:z.enum(["STARTER","GROWTH","PRO"]),
  note:z.string().trim().max(1500).optional().default("")
});
const decisionSchema=z.object({decision:z.enum(["APPROVED","REJECTED"])});

export async function createBusinessPlanUpgradeRequest(req,res){
  const parsed=businessRequestSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:parsed.error.issues[0]?.message||"Choose a valid plan."});

  const business=await Business.findOne({_id:req.tenantId,status:"ACTIVE"}).select("_id");
  if(!business)return res.status(404).json({message:"Active business not found."});

  const existing=await PlanUpgradeRequest.findOne({businessId:business._id,status:"PENDING"}).select("_id").lean();
  if(existing)return res.status(409).json({message:"Your business already has a pending plan request. Please wait for it to be reviewed."});

  try{
    const request=await PlanUpgradeRequest.create({
      businessId:business._id,
      ownerId:req.user._id,
      requestedPlan:parsed.data.plan,
      note:parsed.data.note
    });
    return res.status(201).json({request,message:"Your plan request was sent to Xyron Admin for review."});
  }catch(error){
    if(error?.code===11000)return res.status(409).json({message:"Your business already has a pending plan request. Please wait for it to be reviewed."});
    throw error;
  }
}

export async function listSuperAdminPlanUpgradeRequests(req,res){
  const requests=await PlanUpgradeRequest.find()
    .populate("businessId","name slug status subscriptionPlan")
    .sort({createdAt:-1})
    .limit(300)
    .lean();
  return res.json({requests});
}

export async function reviewPlanUpgradeRequest(req,res){
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:"Invalid plan request ID."});
  const parsed=decisionSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({message:"Choose approve or reject for this plan request."});

  const existing=await PlanUpgradeRequest.findById(req.params.id);
  if(!existing)return res.status(404).json({message:"Plan request not found."});
  if(existing.status!=="PENDING")return res.status(409).json({message:"This plan request has already been reviewed."});

  let business=null;
  if(parsed.data.decision==="APPROVED"){
    business=await Business.findById(existing.businessId);
    if(!business)return res.status(409).json({message:"The business for this plan request is no longer available."});
    if(business.status!=="ACTIVE")return res.status(409).json({message:"Only an active business can have its plan upgraded."});
  }

  const reviewedAt=new Date();
  const request=await PlanUpgradeRequest.findOneAndUpdate(
    {_id:existing._id,status:"PENDING"},
    {$set:{status:parsed.data.decision,reviewedBy:req.user._id,reviewedAt}},
    {new:true,runValidators:true}
  );
  if(!request)return res.status(409).json({message:"This plan request has already been reviewed."});

  if(business){
    try{
      business.subscriptionPlan=existing.requestedPlan;
      business.subscriptionFeatures=getPlanFeatureDefaults(existing.requestedPlan);
      business.markModified("subscriptionFeatures");
      if(!business.subscriptionActivatedAt)business.subscriptionActivatedAt=reviewedAt;
      await business.save();
      await BusinessApplication.updateOne({businessId:business._id},{$set:{selectedPlan:existing.requestedPlan}});
    }catch(error){
      await PlanUpgradeRequest.updateOne(
        {_id:request._id,status:"APPROVED",reviewedBy:req.user._id},
        {$set:{status:"PENDING"},$unset:{reviewedBy:1,reviewedAt:1}}
      );
      throw error;
    }
  }

  return res.json({
    message:parsed.data.decision==="APPROVED"?"Plan request approved and plan features activated.":"Plan request rejected.",
    request
  });
}
