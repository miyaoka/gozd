import type {
  VoicevoxCheckEngineResponse,
  VoicevoxLaunchResponse,
  VoicevoxListSpeakersResponse,
  VoicevoxSpeakRequest,
  VoicevoxSpeakResponse,
} from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

export const rpcVoicevoxLaunch = () => rpc<VoicevoxLaunchResponse>("/voicevox/launch", {});

export const rpcVoicevoxCheckEngine = () =>
  rpc<VoicevoxCheckEngineResponse>("/voicevox/checkEngine", {});

export const rpcVoicevoxListSpeakers = () =>
  rpc<VoicevoxListSpeakersResponse>("/voicevox/listSpeakers", {});

export const rpcVoicevoxSpeak = (req: VoicevoxSpeakRequest) =>
  rpc<VoicevoxSpeakResponse>("/voicevox/speak", req);
