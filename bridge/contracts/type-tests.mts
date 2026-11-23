// These directives fail tsc if the invalid API shapes ever stop producing errors.
// No `any`, unchecked JSON or hand-written duplicate interfaces on this boundary.
import type {RuntimeStatus,ToolInput} from './contract.mjs';
const valid:RuntimeStatus={session_id:'ses_fixture',status:'working',completion:'unconfirmed',reason:null,updated_at:1,can_message:true,last_user_message_id:null,last_user_ms:0,top_level:true,attention_assessed:false,directory:null,health:'running'};
// @ts-expect-error unknown status must not become an untyped string
const wrongStatus:RuntimeStatus={...valid,status:'invented'};
// @ts-expect-error undeclared payload fields are not part of the API
const extraField:RuntimeStatus={...valid,private_tool_output:'not allowed'};
const {completion,...missingCompletion}=valid;
// @ts-expect-error new required wire properties must be supplied by the producer
const missingField:RuntimeStatus=missingCompletion;
// @ts-expect-error mutating MCP calls require literal confirmed:true
const unapproved:ToolInput<'start_session'>={operation_id:'operation_fixture',directory:'/fixture',text:'test',confirmed:false};
// @ts-expect-error MCP call arguments must match their named tool
const wrongTool:ToolInput<'session_health'>={query:'some name'};
// @ts-expect-error handlers cannot read invented tool arguments
const wrongArgument=({} as ToolInput<'list_sessions'>).invented;
void [valid,wrongStatus,extraField,completion,missingField,unapproved,wrongTool,wrongArgument];
