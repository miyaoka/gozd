import {
  VoicevoxCheckEngineRequest,
  VoicevoxCheckEngineResponse,
  VoicevoxLaunchRequest,
  VoicevoxLaunchResponse,
  VoicevoxSpeakRequest,
  VoicevoxSpeakResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcVoicevoxLaunch = (req: VoicevoxLaunchRequest = VoicevoxLaunchRequest.create()) =>
  rpc("/voicevox/launch", req, VoicevoxLaunchRequest, VoicevoxLaunchResponse);

export const rpcVoicevoxCheckEngine = (
  req: VoicevoxCheckEngineRequest = VoicevoxCheckEngineRequest.create(),
) => rpc("/voicevox/checkEngine", req, VoicevoxCheckEngineRequest, VoicevoxCheckEngineResponse);

export const rpcVoicevoxSpeak = (req: VoicevoxSpeakRequest) =>
  rpc("/voicevox/speak", req, VoicevoxSpeakRequest, VoicevoxSpeakResponse);
