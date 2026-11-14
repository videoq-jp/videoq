import {MemorySaver} from "@langchain/langgraph-checkpoint";
import {checkpointContract} from "./contracts/checkpoint.contract";
checkpointContract('LangGraph MemorySaver',async()=>({saver:new MemorySaver(),threadId:'checkpoint-thread',dispose:async()=>{}}));
