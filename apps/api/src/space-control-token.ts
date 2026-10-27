import { createHmac,timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { agentTokenLive, agentTokenTtlMs } from "./cli-browser-bridge.js";
const claimsSchema=z.object({roomId:z.string().min(1).max(200),paneId:z.string().min(1).max(200),cliSessionId:z.string().min(1).max(200),iat:z.number().int().positive().optional(),exp:z.number().int().positive()}).strict();
const prefix="spacecontrol.v1";
export const controlTokenHeader="x-space-control-token";
const signature=(secret:string,payload:string)=>createHmac("sha256",`space-control:${secret}`).update(payload).digest();
export function issueControlToken(secret:string|null,context:{roomId?:string|null;paneId?:string|null;cliSessionId?:string|null;purpose?:string|null}){
 if(!secret||context.purpose==="LOGIN"||!context.roomId||!context.paneId||!context.cliSessionId)return null;
 const payload=Buffer.from(JSON.stringify(claimsSchema.parse({roomId:context.roomId,paneId:context.paneId,cliSessionId:context.cliSessionId,iat:Math.floor(Date.now()/1000),exp:Math.floor((Date.now()+agentTokenTtlMs)/1000)}))).toString("base64url");
 return `${prefix}.${payload}.${signature(secret,payload).toString("base64url")}`;
}
export function verifyControlToken(secret:string|null,token:unknown){
 if(!secret||typeof token!=="string"||token.length>2000)return null;
 const [a,b,payload,sig,...rest]=token.split(".");if(`${a}.${b}`!==prefix||!payload||!sig||rest.length)return null;
 try{const given=Buffer.from(sig,"base64url"),expected=signature(secret,payload);if(given.length!==expected.length||!timingSafeEqual(given,expected))return null;
  const claims=claimsSchema.parse(JSON.parse(Buffer.from(payload,"base64url").toString()));// Tokens from before iat was added were issued 12 hours before their exp.
  return agentTokenLive(claims.iat??claims.exp-43200)?claims:null;
 }catch{return null;}
}
