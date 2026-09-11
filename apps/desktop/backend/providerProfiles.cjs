'use strict';
// The legacy Claude IPC shape over the shared application catalog.
const shared = require('./modelProviders.cjs');
function legacyProfile(profile) { return { ...profile, model: profile.primaryModel || profile.models[0]?.id || '', smallFastModel: profile.smallFastModel || '' }; }
function listProfiles() {
  const list=shared.listProfiles(), selected=list.models.find(model=>model.key===list.defaultModel);
  return { profiles:list.profiles.map(legacyProfile), defaultProfileId:selected?.providerId || null, hasCustomProfile:list.profiles.length>0 };
}
function upsertProfile(input={}) {
  if (!input.id && !input.apiKey) return { ok:false,message:'Provide an API key for the provider.' };
  const existing=input.id?shared.getProfile(input.id):null;
  const models=[...new Set([input.model,input.smallFastModel].filter(Boolean))];
  const result=shared.upsertProfile({ ...input, models, primaryModel:input.model, smallFastModel:input.smallFastModel||'', apiMode:existing?.apiMode || 'anthropic' });
  return result.ok ? { ...result,profile:legacyProfile(result.profile) } : result;
}
function setDefaultProfile(id) {
  const profile=id?shared.getProfile(id):shared.listProfiles().profiles[0];
  if(!profile) return {ok:id===null,message:id===null?undefined:'That provider no longer exists.'};
  return shared.setDefaultModel(shared.modelKey(profile.id,profile.primaryModel || profile.models[0].id));
}
function buildProfileEnv(id) {
  const connection=shared.getProfileConnection(id);if(!connection)return null;
  const env={ANTHROPIC_BASE_URL:connection.baseUrl,ANTHROPIC_AUTH_TOKEN:connection.apiKey,ANTHROPIC_MODEL:connection.model};
  if(connection.smallFastModel)env.ANTHROPIC_SMALL_FAST_MODEL=connection.smallFastModel;
  return env;
}
module.exports={listProfiles,upsertProfile,setDefaultProfile,deleteProfile:shared.deleteProfile,buildProfileEnv,getProfileConnection:shared.getProfileConnection};
