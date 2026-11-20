const PINCODE_PATTERN=/^[1-9]\d{5}$/;
const CACHE_DURATION_MS=6*60*60*1000;
const UNKNOWN_CACHE_DURATION_MS=5*60*1000;
const cache=new Map();
const pendingLookups=new Map();

export class PincodeLookupError extends Error{
  constructor(message,cause){
    super(message,{cause});
    this.name="PincodeLookupError";
    this.status=502;
  }
}

export async function findPostalPincodeDetails(value){
  const pincode=String(value??"").trim();
  if(!PINCODE_PATTERN.test(pincode)){
    const error=new Error("pincode must be a valid 6-digit Indian PIN code.");
    error.status=400;
    throw error;
  }

  const cached=cache.get(pincode);
  if(cached&&cached.expiresAt>Date.now())return cached.details;
  if(pendingLookups.has(pincode))return pendingLookups.get(pincode);

  const lookup=(async()=>{
    let response;
    try{
      response=await fetch(`https://api.postalpincode.in/pincode/${pincode}`,{
        headers:{Accept:"application/json"},
        signal:AbortSignal.timeout(8000)
      });
    }catch(error){
      throw new PincodeLookupError("The India Post PIN lookup is temporarily unavailable.",error);
    }
    if(!response.ok)throw new PincodeLookupError("The India Post PIN lookup is temporarily unavailable.");

    let payload;
    try{payload=await response.json();}
    catch(error){throw new PincodeLookupError("The India Post PIN lookup returned an invalid response.",error);}

    const result=Array.isArray(payload)?payload[0]:null;
    const offices=Array.isArray(result?.PostOffice)?result.PostOffice:[];
    if(result?.Status!=="Success"||offices.length===0){
      cache.set(pincode,{details:null,expiresAt:Date.now()+UNKNOWN_CACHE_DURATION_MS});
      return null;
    }

    const office=offices.find(item=>item.Pincode===pincode&&item.District&&item.State)||offices[0];
    if(!office?.District||!office?.State){
      throw new PincodeLookupError("The India Post PIN lookup did not include a district and state.");
    }
    const details={
      pincode,
      district:String(office.District).trim(),
      state:String(office.State).trim(),
      country:String(office.Country||"India").trim()
    };
    cache.set(pincode,{details,expiresAt:Date.now()+CACHE_DURATION_MS});
    return details;
  })();

  pendingLookups.set(pincode,lookup);
  try{return await lookup;}
  finally{if(pendingLookups.get(pincode)===lookup)pendingLookups.delete(pincode);}
}
