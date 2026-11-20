const normalized=value=>String(value||"").trim().normalize("NFKC").replace(/[.,]/g,"").toLocaleUpperCase("en-IN");

export function calculateRegionalDeliveryChargePaisa(weightGrams,ratePerKgPaisa){
  const weight=Number(weightGrams),rate=Number(ratePerKgPaisa);
  if(!Number.isFinite(weight)||weight<=0)throw new Error("Order weight must be a positive number of grams.");
  if(!Number.isSafeInteger(rate)||rate<0)throw new Error("Regional price must be a non-negative whole number of paise per kilogram.");
  const charge=Math.round(weight*rate/1000);
  if(!Number.isSafeInteger(charge))throw new Error("Delivery charge exceeds the supported calculation range.");
  return charge;
}

export function resolveDeliveryRate({business,customerPincode,customerLocation,businessLocation}){
  const pincode=String(customerPincode||"").trim();
  const regions=business.deliveryRegions||[];
  const byPincode=regions.find(region=>region.matchType==="PINCODE"&&region.pincode===pincode);
  if(byPincode)return {...(byPincode._id?{id:String(byPincode._id)}:{}),name:byPincode.name,ratePerKgPaisa:byPincode.ratePerKgPaisa,matchType:"PINCODE"};

  const samePincode=pincode&&pincode===String(business.pincode||"");
  if(!customerLocation?.district||!customerLocation?.state){
    const rate=business.deliveryRates?.localPaisa;
    return samePincode&&Number.isSafeInteger(rate)?{name:"Local delivery",ratePerKgPaisa:rate,matchType:"LOCAL"}:null;
  }

  const customerDistrict=normalized(customerLocation.district);
  const customerState=normalized(customerLocation.state);
  const businessDistrict=normalized(businessLocation?.district||business.city);
  const businessState=normalized(businessLocation?.state||business.state);
  const sameDistrict=customerDistrict===businessDistrict&&customerState===businessState;

  const districtOverride=regions.find(region=>
    region.matchType==="DISTRICT"&&
    normalized(region.district)===customerDistrict&&
    normalized(region.state)===customerState
  );
  if(districtOverride)return {...(districtOverride._id?{id:String(districtOverride._id)}:{}),name:districtOverride.name,ratePerKgPaisa:districtOverride.ratePerKgPaisa,matchType:"DISTRICT"};

  const stateOverride=regions.find(region=>
    region.matchType==="STATE"&&normalized(region.state)===customerState
  );
  if(stateOverride)return {...(stateOverride._id?{id:String(stateOverride._id)}:{}),name:stateOverride.name,ratePerKgPaisa:stateOverride.ratePerKgPaisa,matchType:"STATE"};

  if(samePincode){
    const rate=business.deliveryRates?.localPaisa;
    return Number.isSafeInteger(rate)?{name:"Local delivery",ratePerKgPaisa:rate,matchType:"LOCAL"}:null;
  }
  if(sameDistrict){
    const rate=business.deliveryRates?.sameDistrictPaisa;
    return Number.isSafeInteger(rate)?{name:"Same district",ratePerKgPaisa:rate,matchType:"SAME_DISTRICT"}:null;
  }

  if(customerState===businessState){
    const rate=business.deliveryRates?.sameStatePaisa;
    return Number.isSafeInteger(rate)?{name:"Same state",ratePerKgPaisa:rate,matchType:"SAME_STATE"}:null;
  }

  const rate=business.deliveryRates?.otherStatePaisa;
  return Number.isSafeInteger(rate)?{name:"Other state",ratePerKgPaisa:rate,matchType:"OTHER_STATE"}:null;
}
