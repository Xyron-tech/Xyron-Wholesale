import {getBusinessPaymentMethod} from "./businessPaymentMethod.js";

export function createPaymentInfoSnapshot(business,updatedAt=new Date()){
  const paymentMethod=getBusinessPaymentMethod(business);
  if(paymentMethod==="OFF"){
    return {
      paymentMethodSnapshot:"OFF",
      paymentQrSnapshot:"",
      upiIdSnapshot:"",
      paymentInstructionsSnapshot:"",
      updatedAt
    };
  }
  if(paymentMethod==="QR"&&!business.paymentQrUrl)return null;
  if(paymentMethod==="GPAY"&&!business.upiId?.trim())return null;
  return {
    paymentMethodSnapshot:paymentMethod,
    paymentQrSnapshot:paymentMethod==="QR"?business.paymentQrUrl:"",
    upiIdSnapshot:paymentMethod==="GPAY"?business.upiId.trim():"",
    paymentInstructionsSnapshot:business.paymentInstructions?.trim()||"",
    updatedAt
  };
}

export function hasPaymentInfoChanged(previous,next){
  if(!previous||!next)return previous!==next;
  return ["paymentMethodSnapshot","paymentQrSnapshot","upiIdSnapshot","paymentInstructionsSnapshot"]
    .some(field=>previous[field]!==next[field]);
}
