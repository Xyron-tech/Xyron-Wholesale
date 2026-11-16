export function getBusinessPaymentMethod(business){
  if(["QR","GPAY","OFF"].includes(business.paymentMethod))return business.paymentMethod;
  if(business.paymentQrEnabled===false)return "OFF";
  if(business.paymentQrUrl)return "QR";
  if(business.upiId?.trim())return "GPAY";
  return "QR";
}
