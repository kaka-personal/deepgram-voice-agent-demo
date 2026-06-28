"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

import Transcript from "./Transcript";
import { useDeepgram } from "../context/DeepgramContextProvider";
import { useMicrophone } from "../context/MicrophoneContextProvider";
import { EventType, useVoiceBot, VoiceBotStatus } from "../context/VoiceBotContextProvider";
import { createAudioBuffer, playAudioBuffer } from "../utils/audioUtils";
import { sendSocketMessage, sendMicToSocket } from "app/utils/deepgramUtils";
import { isMobile } from "react-device-detect";
import { usePrevious } from "@uidotdev/usehooks";
import { useStsQueryParams } from "app/hooks/UseStsQueryParams";
import RateLimited from "./RateLimited";

const AnimationManager = dynamic(() => import("./AnimationManager"), {
  ssr: false,
});

export const App = ({
  defaultStsConfig,
  onMessageEvent = () => {},
  requiresUserActionToInitialize = false,
  className = "",
}) => {
  const {
    status,
    messages,
    addVoicebotMessage,
    attachLatency,
    addBehindTheScenesEvent,
    isWaitingForUserVoiceAfterSleep,
    toggleSleep,
    startListening,
    startSpeaking,
  } = useVoiceBot();
  const {
    setupMicrophone,
    microphone,
    microphoneState,
    processor,
    microphoneAudioContext,
    startMicrophone,
  } = useMicrophone();
  const { socket, connectToDeepgram, socketState, rateLimited } = useDeepgram();
  const { voice, prompt, applyParamsToConfig } = useStsQueryParams();
  const audioContext = useRef(null);
  const agentVoiceAnalyser = useRef(null);
  const userVoiceAnalyser = useRef(null);
  const startTimeRef = useRef(-1);
  // Latest status in a ref so the message handler (a useCallback) never reads a stale value.
  const statusRef = useRef(status);
  statusRef.current = status;

  // User-speech timing for transcript timestamps: when the user started talking,
  // when the last activity ended (to measure the silence before they spoke).
  const userSpeechStartRef = useRef(null);
  const lastActivityEndRef = useRef(null);
  const pendingSilenceRef = useRef(null);
  // Latency for a turn arrives (AgentStartedSpeaking) mid-turn; we stash it and attach it
  // to the turn's last assistant message at AgentAudioDone, so it never gets misaligned
  // (e.g. by the greeting, which has no latency).
  const pendingLatencyRef = useRef(null);

  // Server latency (ttt/tts/total) is measured inside Deepgram and excludes the
  // client↔Deepgram network. We measure one round-trip (Settings→SettingsApplied)
  // to surface the China→US network leg the server-side numbers don't show.
  const settingsSentAtRef = useRef(null);
  const networkRttRef = useRef(null);
  // Client-side per-turn metrics: greeting first-audio, real response gap, audio length, eager/resumed.
  const settingsAppliedAtRef = useRef(null);
  const greetingMeasuredRef = useRef(false);
  const userDoneAtRef = useRef(null);
  const turnFirstAudioRef = useRef(null);
  const turnAudioBytesRef = useRef(0);
  const turnEagerRef = useRef(false);
  const turnResumedRef = useRef(false);
  const [isInitialized, setIsInitialized] = useState(requiresUserActionToInitialize ? false : null);
  const previousVoice = usePrevious(voice);
  const previousPrompt = usePrevious(prompt);
  const scheduledAudioSources = useRef([]);
  const pathname = usePathname();

  // AUDIO MANAGEMENT
  /**
   * Initialize the audio context for managing and playing audio. (just for TTS playback; user audio input logic found in Microphone Context Provider)
   */
  useEffect(() => {
    if (!audioContext.current) {
      audioContext.current = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
        sampleRate: 24000,
      });
      agentVoiceAnalyser.current = audioContext.current.createAnalyser();
      agentVoiceAnalyser.current.fftSize = 2048;
      agentVoiceAnalyser.current.smoothingTimeConstant = 0.96;
    }
  }, []);

  /**
   * Callback to handle audio data processing and playback.
   * Converts raw audio into an AudioBuffer and plays the processed audio through the web audio context
   */
  const bufferAudio = useCallback((data) => {
    const audioBuffer = createAudioBuffer(audioContext.current, data);
    if (!audioBuffer) return;
    scheduledAudioSources.current.push(
      playAudioBuffer(audioContext.current, audioBuffer, startTimeRef, agentVoiceAnalyser.current),
    );
  }, []);

  const clearAudioBuffer = () => {
    scheduledAudioSources.current.forEach((source) => source.stop());
    scheduledAudioSources.current = [];
  };

  // MICROPHONE AND SOCKET MANAGEMENT
  /**
   * Open the microphone at the very start when there isn't one.
   * Logic for microphone found in Microphone Context Provider
   */
  useEffect(() => {
    setupMicrophone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let wakeLock;
    const requestWakeLock = async () => {
      try {
        // Wake lock will only be successfully granted if this useEffect is triggered as a result of a user action (a click or tap)
        if ("wakeLock" in navigator) {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch (err) {
        console.error(err);
      }
    };

    if (isInitialized) {
      requestWakeLock();
    }

    return () => {
      if (wakeLock) {
        wakeLock.release();
      }
    };
  }, [isInitialized]);

  /**
   * Open Deepgram once the microphone opens.
   * Runs whenever the `microphone` changes state, but exits if no microphone state.
   * `microphone` is only set once it is ready to open and record audio.
   */
  useEffect(() => {
    if (microphoneState === 1 && socket && defaultStsConfig) {
      /**
       * When the connection to Deepgram opens, the following will happen;
       *  1. Send the API configuration first.
       *  3. Start the microphone immediately.
       *  4. Update the app state to the INITIAL listening state.
       */

      const onOpen = () => {
        const combinedStsConfig = applyParamsToConfig(defaultStsConfig);

        sendSocketMessage(socket, combinedStsConfig);
        settingsSentAtRef.current = Date.now();
        startMicrophone();
        startListening(true);
        // Start awake (do not toggleSleep here) so the configured `greeting`
        // is actually spoken on connect — sleeping would suppress it.
      };

      socket.addEventListener("open", onOpen);

      /**
       * Cleanup function runs before component unmounts. Use this
       * to deregister/remove event listeners.
       */
      return () => {
        socket.removeEventListener("open", onOpen);
        microphone.ondataavailable = null;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [microphone, socket, microphoneState, defaultStsConfig, pathname]);

  /**
   * Performs checks to ensure that the system is ready to proceed with setting up the data transmission
   * Attaches an event listener to the microphone which sends audio data through the WebSocket as it becomes available
   */
  useEffect(() => {
    if (!microphone) return;
    if (!socket) return;
    if (microphoneState !== 2) return;
    if (socketState !== 1) return;
    processor.onaudioprocess = sendMicToSocket(socket);
  }, [microphone, socket, microphoneState, socketState, processor]);

  useEffect(() => {
    if (!processor || socket?.readyState !== 1) return;
    if (status === VoiceBotStatus.SLEEPING) {
      processor.onaudioprocess = null;
    } else {
      processor.onaudioprocess = sendMicToSocket(socket);
    }
  }, [status, processor, socket]);

  /**
   * Create AnalyserNode for user microphone audio context.
   * Exposes audio time / frequency data which is used in the
   * AnimationManager to scale the animations in response to user/agent voice
   */
  useEffect(() => {
    if (microphoneAudioContext) {
      userVoiceAnalyser.current = microphoneAudioContext.createAnalyser();
      userVoiceAnalyser.current.fftSize = 2048;
      userVoiceAnalyser.current.smoothingTimeConstant = 0.96;
      microphone.connect(userVoiceAnalyser.current);
    }
  }, [microphoneAudioContext, microphone]);

  /**
   * Handles incoming WebSocket messages. Differentiates between ArrayBuffer data and other data types (basically just string type).
   * */
  const onMessage = useCallback(
    async (event) => {
      // Binary frames are TTS audio — play them directly.
      if (event.data instanceof ArrayBuffer) {
        if (statusRef.current !== VoiceBotStatus.SLEEPING && !isWaitingForUserVoiceAfterSleep.current) {
          if (turnFirstAudioRef.current == null) turnFirstAudioRef.current = Date.now();
          turnAudioBytesRef.current += event.data.byteLength;
          bufferAudio(event.data);
        }
        return;
      }

      onMessageEvent(event.data);

      let parsedData;
      try {
        parsedData = JSON.parse(event.data);
      } catch (error) {
        console.error(event.data, error);
        return;
      }
      if (!parsedData) return;

      maybeRecordBehindTheScenesEvent(parsedData);

      // Transcript lines come ONLY from `ConversationText`. The Agent API also emits a
      // `History` event with the same role + content; keying off `role` alone (as before)
      // double-counted every line. Handling each frame here (instead of via a single
      // overwritten `data` state) also stops bursts from dropping lines.
      if (parsedData.type === EventType.CONVERSATION_TEXT) {
        if (parsedData.role === "user") {
          startListening();
          if (statusRef.current !== VoiceBotStatus.SLEEPING) {
            const endedAt = Date.now();
            addVoicebotMessage({
              user: parsedData.content,
              startedAt: userSpeechStartRef.current,
              endedAt,
              silenceBefore: pendingSilenceRef.current,
            });
            lastActivityEndRef.current = endedAt;
            userDoneAtRef.current = endedAt;
            userSpeechStartRef.current = null;
          }
        } else if (parsedData.role === "assistant") {
          if (statusRef.current !== VoiceBotStatus.SLEEPING && !isWaitingForUserVoiceAfterSleep.current) {
            startSpeaking();
            addVoicebotMessage({ assistant: parsedData.content });
          }
        }
      }

      if (parsedData.type === EventType.AGENT_AUDIO_DONE) {
        lastActivityEndRef.current = Date.now();
        // 24kHz * 16-bit mono = 48 bytes per millisecond of audio.
        const audioDurationMs = Math.round(turnAudioBytesRef.current / 48);
        if (pendingLatencyRef.current) {
          // A normal turn: merge server latency with client-side measurements.
          const measuredResponse =
            turnFirstAudioRef.current != null && userDoneAtRef.current != null
              ? turnFirstAudioRef.current - userDoneAtRef.current
              : null;
          attachLatency({
            ...pendingLatencyRef.current,
            measuredResponse,
            audioDurationMs,
            eager: turnEagerRef.current,
            resumed: turnResumedRef.current,
          });
          pendingLatencyRef.current = null;
        } else if (
          !greetingMeasuredRef.current &&
          settingsAppliedAtRef.current != null &&
          turnFirstAudioRef.current != null
        ) {
          // The opening greeting (no server latency) — client-measured first-audio time.
          greetingMeasuredRef.current = true;
          attachLatency({
            ttt_latency: 0,
            tts_latency: 0,
            total_latency: 0,
            greetingTtfa: turnFirstAudioRef.current - settingsAppliedAtRef.current,
            networkRtt: networkRttRef.current,
            audioDurationMs,
          });
        }
        startListening();
      }
      if (parsedData.type === EventType.USER_STARTED_SPEAKING) {
        isWaitingForUserVoiceAfterSleep.current = false;
        const now = Date.now();
        pendingSilenceRef.current =
          lastActivityEndRef.current != null ? now - lastActivityEndRef.current : null;
        userSpeechStartRef.current = now;
        // New turn — reset per-turn measurements.
        turnFirstAudioRef.current = null;
        turnAudioBytesRef.current = 0;
        turnEagerRef.current = false;
        turnResumedRef.current = false;
        startListening();
        clearAudioBuffer();
      }
      if (parsedData.type === EventType.EAGER_END_OF_TURN) {
        turnEagerRef.current = true;
      }
      // Eager end-of-turn (Flux): the agent may start an "eager" reply before the user
      // truly finished. If the user keeps talking, the server sends TurnResumed — discard
      // any audio we already started playing so the early/stale reply doesn't talk over them.
      if (parsedData.type === EventType.TURN_RESUMED) {
        turnResumedRef.current = true;
        startListening();
        clearAudioBuffer();
      }
      if (parsedData.type === EventType.SETTINGS_APPLIED) {
        settingsAppliedAtRef.current = Date.now();
        if (settingsSentAtRef.current != null) {
          networkRttRef.current = Date.now() - settingsSentAtRef.current;
          console.log(`[network] 往返 (中国↔Deepgram US) ~${networkRttRef.current} ms`);
        }
      }
      if (parsedData.type === EventType.AGENT_STARTED_SPEAKING) {
        const { tts_latency, ttt_latency, total_latency } = parsedData;
        const timestamp = Date.now();
        const ts = new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
        const rtt = networkRttRef.current;
        console.log(
          `[latency ${ts}] 思考(LLM) ${Math.round(ttt_latency * 1000)}ms · 合成(TTS) ${Math.round(
            tts_latency * 1000,
          )}ms · 总计 ${Math.round(total_latency * 1000)}ms${
            rtt != null ? ` · 网络往返 ~${rtt}ms` : ""
          }`,
        );
        if (!tts_latency || !ttt_latency) return;
        pendingLatencyRef.current = { tts_latency, ttt_latency, total_latency, timestamp, networkRtt: rtt };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bufferAudio, onMessageEvent, startListening, startSpeaking],
  );

  /**
   * Opens Deepgram when the microphone opens.
   * Runs whenever `microphone` changes state, but exits if no microphone state.
   */
  useEffect(() => {
    if (
      microphoneState === 1 &&
      socketState === -1 &&
      (!requiresUserActionToInitialize || (requiresUserActionToInitialize && isInitialized))
    ) {
      connectToDeepgram();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    microphone,
    socket,
    microphoneState,
    socketState,
    isInitialized,
    requiresUserActionToInitialize,
  ]);

  /**
   * Sets up a WebSocket message event listener to handle incoming messages through the 'onMessage' callback.
   */
  useEffect(() => {
    if (socket) {
      socket.addEventListener("message", onMessage);
      return () => socket.removeEventListener("message", onMessage);
    }
  }, [socket, onMessage]);

  useEffect(() => {
    if (previousVoice && previousVoice !== voice && socket && socketState === 1) {
      sendSocketMessage(socket, {
        type: "UpdateSpeak",
        speak: {
          provider: {
            type: "deepgram",
            model: voice,
          },
        },
      });
    }
  }, [voice, socket, socketState, previousVoice]);

  useEffect(() => {
    if (previousPrompt !== prompt && socket && socketState === 1) {
      sendSocketMessage(socket, {
        type: "UpdatePrompt",
        prompt: `${defaultStsConfig.agent.think.prompt}\n${prompt}`,
      });
    }
  }, [defaultStsConfig, previousPrompt, prompt, socket, socketState]);

  // Server messages are now handled directly in `onMessage` (above), so each frame is
  // processed exactly once. Previously they were funnelled through a single `data` state
  // variable + this effect, which dropped frames under bursts and double-counted lines.

  const handleVoiceBotAction = () => {
    if (requiresUserActionToInitialize && !isInitialized) {
      setIsInitialized(true);
    }

    if (status !== VoiceBotStatus.NONE) {
      toggleSleep();
    }
  };

  const maybeRecordBehindTheScenesEvent = (serverMsg) => {
    switch (serverMsg.type) {
      case EventType.SETTINGS_APPLIED:
        addBehindTheScenesEvent({
          type: EventType.SETTINGS_APPLIED,
        });
        break;
      case EventType.USER_STARTED_SPEAKING:
        if (statusRef.current === VoiceBotStatus.SPEAKING) {
          addBehindTheScenesEvent({
            type: "Interruption",
          });
        }
        addBehindTheScenesEvent({
          type: EventType.USER_STARTED_SPEAKING,
        });
        break;
      case EventType.AGENT_STARTED_SPEAKING:
        addBehindTheScenesEvent({
          type: EventType.AGENT_STARTED_SPEAKING,
        });
        break;
      case EventType.CONVERSATION_TEXT: {
        const role = serverMsg.role;
        const content = serverMsg.content;
        addBehindTheScenesEvent({
          type: EventType.CONVERSATION_TEXT,
          role: role,
          content: content,
        });
        break;
      }
      case EventType.END_OF_THOUGHT:
        addBehindTheScenesEvent({
          type: EventType.END_OF_THOUGHT,
        });
        break;
    }
  };

  if (rateLimited) {
    return <RateLimited />;
  }

  // MAIN UI
  return (
    <div className={className}>
      <AnimationManager
        agentVoiceAnalyser={agentVoiceAnalyser.current}
        userVoiceAnalyser={userVoiceAnalyser.current}
        onOrbClick={handleVoiceBotAction}
      />
      {!microphone ? (
        <div className="text-base text-gray-25 text-center w-full">Loading microphone...</div>
      ) : (
        <Fragment>
          {socketState === -1 && requiresUserActionToInitialize && (
            <button className="text-center w-full" onClick={handleVoiceBotAction}>
              <span className="text-xl">Tap to start!</span>
            </button>
          )}
          {socketState === 0 && (
            <div className="text-base text-gray-25 text-center w-full">Loading Deepgram...</div>
          )}
          {socketState > 0 && status === VoiceBotStatus.SLEEPING && (
            <div className="text-xl flex flex-col items-center justify-center mt-4 mb-10 md:mt-4 md:mb-10">
              <div className="text-gray-450 text-sm">
                I&apos;ve stopped listening. {isMobile ? "Tap" : "Click"} the orb to resume.
              </div>
            </div>
          )}
          {/* Transcript Section */}
          <div
            className={`h-20 md:h-12 text-sm md:text-base mt-2 flex flex-col items-center text-gray-200 overflow-y-auto`}
          >
            {messages.length > 0 ? <Transcript /> : null}
          </div>
        </Fragment>
      )}
    </div>
  );
};
