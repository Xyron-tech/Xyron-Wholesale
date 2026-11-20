import test from "node:test";
import assert from "node:assert/strict";
import {calculateRegionalDeliveryChargePaisa,resolveDeliveryRate} from "./deliveryPricing.js";

test("prices an order from its actual weight without rounding to whole kilograms",()=>{
  assert.equal(calculateRegionalDeliveryChargePaisa(1500,10000),15000);
  assert.equal(calculateRegionalDeliveryChargePaisa(1250,8500),10625);
});

test("rounds calculated fractional paise to the nearest paisa",()=>{
  assert.equal(calculateRegionalDeliveryChargePaisa(1001,1),1);
});

test("rejects invalid weights and regional rates",()=>{
  assert.throws(()=>calculateRegionalDeliveryChargePaisa(0,1000),/positive number/);
  assert.throws(()=>calculateRegionalDeliveryChargePaisa(1000,-1),/non-negative whole number/);
});

test("resolves base delivery prices from PIN, district, state, and other-state location",()=>{
  const business={
    pincode:"613001",
    city:"Thanjavur",
    state:"Tamil Nadu",
    deliveryRates:{localPaisa:1000,sameDistrictPaisa:2000,sameStatePaisa:3000,otherStatePaisa:4000},
    deliveryRegions:[]
  };
  const result=location=>resolveDeliveryRate({business,...location});

  assert.equal(result({customerPincode:"613001"}).matchType,"LOCAL");
  assert.equal(result({customerPincode:"613002",customerLocation:{district:"Thanjavur",state:"Tamil Nadu"}}).matchType,"SAME_DISTRICT");
  assert.equal(result({customerPincode:"620001",customerLocation:{district:"Tiruchirappalli",state:"Tamil Nadu"}}).matchType,"SAME_STATE");
  assert.equal(result({customerPincode:"560001",customerLocation:{district:"Bengaluru Urban",state:"Karnataka"}}).matchType,"OTHER_STATE");
});

test("PIN, district, and state-specific prices override base delivery prices",()=>{
  const business={
    pincode:"613001",
    city:"Thanjavur",
    state:"Tamil Nadu",
    deliveryRates:{localPaisa:1000,sameDistrictPaisa:2000,sameStatePaisa:3000,otherStatePaisa:4000},
    deliveryRegions:[
      {_id:"pin-rate",name:"PIN override",matchType:"PINCODE",pincode:"613002",ratePerKgPaisa:5100},
      {_id:"district-rate",name:"City override",matchType:"DISTRICT",district:"Tiruchirappalli",state:"Tamil Nadu",ratePerKgPaisa:5200},
      {_id:"state-rate",name:"State override",matchType:"STATE",state:"Karnataka",ratePerKgPaisa:5300}
    ]
  };
  const result=location=>resolveDeliveryRate({business,...location});

  assert.equal(result({customerPincode:"613002"}).ratePerKgPaisa,5100);
  assert.equal(result({customerPincode:"620001",customerLocation:{district:"Tiruchirappalli",state:"Tamil Nadu"}}).ratePerKgPaisa,5200);
  assert.equal(result({customerPincode:"560001",customerLocation:{district:"Bengaluru Urban",state:"Karnataka"}}).ratePerKgPaisa,5300);
});

test("matches a configured district override outside the business district",()=>{
  const business={
    pincode:"613001",
    city:"Thanjavur",
    state:"Tamil Nadu",
    deliveryRates:{sameStatePaisa:3000,otherStatePaisa:4000},
    deliveryRegions:[{matchType:"DISTRICT",district:"Chennai",state:"Tamil Nadu",name:"Chennai delivery",ratePerKgPaisa:2500}]
  };
  const result=resolveDeliveryRate({
    business,
    customerPincode:"600001",
    customerLocation:{district:"Chennai",state:"Tamil Nadu"},
    businessLocation:{district:"Thanjavur",state:"Tamil Nadu"}
  });

  assert.equal(result.name,"Chennai delivery");
  assert.equal(result.ratePerKgPaisa,2500);
});

test("leaves the delivery charge pending when no location price matches",()=>{
  const business={pincode:"613001",city:"Thanjavur",state:"Tamil Nadu",deliveryRates:{},deliveryRegions:[]};
  assert.equal(resolveDeliveryRate({
    business,
    customerPincode:"781001",
    customerLocation:{district:"Kamrup Metropolitan",state:"Assam"}
  }),null);
});
