import mongoose from "mongoose";

const schema=new mongoose.Schema({
  businessId:{type:mongoose.Schema.Types.ObjectId,ref:"Business",required:true},
  ownerId:{type:mongoose.Schema.Types.ObjectId,ref:"User",required:true},
  requestedPlan:{type:String,enum:["STARTER","GROWTH","PRO"],required:true},
  note:{type:String,default:"",trim:true,maxlength:1500},
  status:{type:String,enum:["PENDING","APPROVED","REJECTED"],default:"PENDING",index:true},
  reviewedBy:{type:mongoose.Schema.Types.ObjectId,ref:"User",default:null},
  reviewedAt:Date
},{timestamps:true});

schema.index({businessId:1,createdAt:-1});
schema.index({businessId:1},{unique:true,partialFilterExpression:{status:"PENDING"}});

export default mongoose.model("PlanUpgradeRequest",schema);
