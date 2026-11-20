import mongoose from "mongoose";
import app from "./app.js";
import {connectDB} from "./config/db.js";
import {env} from "./config/env.js";

await connectDB();
const server=app.listen(env.PORT,()=>console.log(`Xyron Wholesale API listening on :${env.PORT}`));
let shuttingDown=false;

function shutdown(signal){
  if(shuttingDown)return;
  shuttingDown=true;
  console.log(`${signal} received; stopping the API gracefully.`);
  const timeout=setTimeout(()=>{
    console.error("API shutdown timed out before active requests and MongoDB connections closed.");
    process.exit(1);
  },25000);
  timeout.unref();
  server.close(async error=>{
    if(error){
      console.error("Could not close the API server cleanly.",error);
      process.exitCode=1;
    }
    try{await mongoose.disconnect();}
    catch(disconnectError){
      console.error("Could not close the MongoDB connection cleanly.",disconnectError);
      process.exitCode=1;
    }finally{clearTimeout(timeout);}
  });
}

process.once("SIGTERM",()=>shutdown("SIGTERM"));
process.once("SIGINT",()=>shutdown("SIGINT"));
