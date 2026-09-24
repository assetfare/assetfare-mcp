import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QUOTE_PAYLOAD_SHA256_SPEC, quotePayloadSha256, quotePayloadV3Projection, typedCanonicalV1 } from "./continuation-v3.js";
import { parseV2Quote } from "./server.js";

const fixture=JSON.parse(readFileSync(new URL("../test/portable-quote-payload-fixture.json",import.meta.url),"utf8"));
const projected=quotePayloadV3Projection(fixture.quote);
assert.equal(projected.intent.amount_usd,1000);
assert.equal(typeof projected.intent.amount_usd,"number");
assert.equal(projected.intent.estimated_input_base,"9007199254741999");
assert.equal(projected.route.input_base,"9007199254741999");
assert.equal(projected.route.expected_output_base,"9007199254740995");
assert.equal(projected.route.minimum_output_base,"9007199254740993");
assert.equal(projected.route.steps[0].expected_input_base,"9007199254741999");
assert.equal(projected.route.steps[0].floor_input_base,"9007199254741999");
assert.equal(projected.route.steps[0].expected_output_base,"9007199254740995");
assert.equal(projected.route.steps[0].minimum_output_base,"9007199254740993");
assert.equal("continuation_v3" in projected,false);
assert.equal(quotePayloadSha256(fixture.quote),fixture.expected_sha256);
assert.equal(QUOTE_PAYLOAD_SHA256_SPEC,"sha256(AssetFare typed-canonical-v1 bytes of the quote without continuation_v3 after exact base-unit substitution: n=null; t/f=boolean; d=<IEEE-754 binary64 big-endian 16 lowercase hex> for each finite JSON number; s=<UTF-8 byte length>:<Unicode scalar text with lone surrogates forbidden>; a=<count>:[items]; o=<count>:{UTF-8-byte-sorted string-key/value pairs}; every non-substituted integral JSON number must be within +/-9007199254740991; substituted paths are intent.estimated_input_base, route.input_base, route.expected_output_base, route.minimum_output_base, and every route.steps[i].expected_input_base/floor_input_base/expected_output_base/minimum_output_base from direct_route_summary exact decimal strings)");

// Independent Python-Core vectors for every typed-canonical family.
assert.equal(typedCanonicalV1(null).toString("hex"),"6e");
assert.equal(typedCanonicalV1(true).toString("hex"),"74");
assert.equal(typedCanonicalV1(false).toString("hex"),"66");
assert.equal(typedCanonicalV1(0).toString(),"d0000000000000000");
assert.equal(typedCanonicalV1(-0).toString(),"d8000000000000000");
assert.notDeepEqual(typedCanonicalV1(0),typedCanonicalV1(-0));
assert.equal(typedCanonicalV1(1).toString(),"d3ff0000000000000");
assert.deepEqual(typedCanonicalV1(1),typedCanonicalV1(1.0));
assert.equal(typedCanonicalV1("1").toString(),"s1:1");
assert.notDeepEqual(typedCanonicalV1(1),typedCanonicalV1("1"));
assert.equal(typedCanonicalV1("é").toString("hex"),"73323ac3a9");
assert.equal(typedCanonicalV1("😀").toString("hex"),"73343af09f9880");
for(const value of ["\uD800","\uDC00"])assert.throws(()=>typedCanonicalV1(value),/string_invalid/);
assert.throws(()=>typedCanonicalV1({["\uD800"]:1}),/string_invalid/);
assert.equal(typedCanonicalV1([1,"1"]).toString("hex"),"61323a5b643366663030303030303030303030303073313a315d");
assert.equal(typedCanonicalV1([true,false]).toString("hex"),"61323a5b74665d");
assert.equal(typedCanonicalV1(["é","e\u0301","😀"]).toString("hex"),"61333a5b73323ac3a973333a65cc8173343af09f98805d");
assert.equal(typedCanonicalV1([null,true,false,"1",1,1.0]).toString("hex"),"61363a5b6e746673313a31643366663030303030303030303030303064336666303030303030303030303030305d");
assert.equal(typedCanonicalV1([-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]).toString("hex"),"61323a5b646333336666666666666666666666666664343333666666666666666666666666665d");
assert.equal(typedCanonicalV1({é:1,z:false}).toString("hex"),"6f323a7b73313a7a6673323ac3a964336666303030303030303030303030307d");
const utf8Order={"\u{10000}":4,"\uE000":3,"é":2,a:1},utf8Encoded=typedCanonicalV1(utf8Order).toString("hex");
assert.equal(utf8Encoded,"6f343a7b73313a61643366663030303030303030303030303073323ac3a9643430303030303030303030303030303073333aee8080643430303830303030303030303030303073343af090808064343031303030303030303030303030307d");
assert.notDeepEqual(typedCanonicalV1("é"),typedCanonicalV1("e\u0301"));
for(const value of [new Date(0),new Map(),new Number(1),Object.assign([], {extra:true})])assert.throws(()=>typedCanonicalV1(value),/value_invalid/);
const symbolObject={};symbolObject[Symbol("hidden")]=1;assert.throws(()=>typedCanonicalV1(symbolObject),/value_invalid/);
const accessorObject={};Object.defineProperty(accessorObject,"value",{enumerable:true,get(){return 1;}});assert.throws(()=>typedCanonicalV1(accessorObject),/value_invalid/);
const sparse=[];sparse.length=1;assert.throws(()=>typedCanonicalV1(sparse),/value_invalid/);
const symbolArray=[1];symbolArray[Symbol("hidden")]=2;assert.throws(()=>typedCanonicalV1(symbolArray),/value_invalid/);
const nonEnumerableArray=[1];Object.defineProperty(nonEnumerableArray,"hidden",{value:2});assert.throws(()=>typedCanonicalV1(nonEnumerableArray),/value_invalid/);
assert.equal(typedCanonicalV1(Number.MAX_SAFE_INTEGER).toString(),"d433fffffffffffff");
for(const value of [Number.MAX_SAFE_INTEGER+1,-(Number.MAX_SAFE_INTEGER+1)])assert.throws(()=>typedCanonicalV1(value),/unsafe_integer/);
for(const value of [Number.NaN,Number.POSITIVE_INFINITY,Number.NEGATIVE_INFINITY])assert.throws(()=>typedCanonicalV1(value),/nonfinite_number/);
const numericStringMutation=structuredClone(fixture.quote);numericStringMutation.offer.assetfare_fee_bps="1";
assert.notEqual(quotePayloadSha256(numericStringMutation),fixture.expected_sha256);
const unsafeOtherInteger=structuredClone(fixture.quote);unsafeOtherInteger.offer.non_substituted_integer=Number.MAX_SAFE_INTEGER+1;
assert.throws(()=>quotePayloadSha256(unsafeOtherInteger),/unsafe_integer/);
const invalidExact=structuredClone(fixture.quote);invalidExact.direct_route_summary.steps[0].expected_input_base="09007199254741999";
assert.throws(()=>quotePayloadSha256(invalidExact),/continuation_v3_quote_invalid/);

// Static fixture produced by the actual Python Core 2.4.1 implementation. The
// source JSON deliberately contains an integral float and an integer that loses
// one unit in JSON.parse; exact direct_route_summary strings must restore it.
const coreText=readFileSync(new URL("../test/core-241-unsafe-integer-quote.json",import.meta.url),"utf8");
assert.ok(coreText.includes('"amount_usd":1000.0'));
assert.ok(coreText.includes('"estimated_input_base":9007199254740993'));
const coreQuote=JSON.parse(coreText),exactUnsafe=coreQuote.direct_route_summary.steps[0].expected_input_base;
assert.equal(coreQuote.intent.estimated_input_base,9007199254740992);
assert.equal(exactUnsafe,"9007199254740993");
assert.notEqual(String(coreQuote.intent.estimated_input_base),exactUnsafe);
const issuedMs=Date.parse(coreQuote.continuation_v3.issued_at),coreParsed=parseV2Quote(coreQuote,{from_chain:"base",from_token:"USDC",to_chain:"arbitrum",to_token:"USDC",amount_usd:1000},{nowMs:issuedMs+1000});
assert.equal(coreParsed.continuation_v3.quote_payload_sha256,"f071dead7a91a993e72ec086ac7948e801880bf24cda916ad0761e962249f17c");
assert.equal(quotePayloadSha256(coreParsed),coreParsed.continuation_v3.quote_payload_sha256);
assert.equal(coreParsed.continuation_v3.input_base_bounds.maximum,exactUnsafe);
console.log(JSON.stringify({status:"pass",python_core_compatible_fixture:true,actual_python_core_241_fixture:true,typed_canonical_v1:true,json_types_preserved:true,numeric_string_distinct:true,negative_zero_distinct:true,safe_integer_boundary_enforced:true,amount_usd_1000_dot_0:true,base_units_above_2pow53:true,parsed_raw_value:coreQuote.intent.estimated_input_base,exact_summary_value:exactUnsafe,lossy_parse_difference_asserted:true,rounded_raw_duplicates_replaced:true,portable_quote_payload_sha256:coreParsed.continuation_v3.quote_payload_sha256}));
