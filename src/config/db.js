import mongoose from "mongoose";import {env} from "./env.js";
export async function connectDB(){mongoose.set("strictQuery",true);await mongoose.connect(env.MONGODB_URI,{autoIndex:env.NODE_ENV!=="production",maxPoolSize:env.MONGODB_MAX_POOL_SIZE});console.log("MongoDB connected");}
