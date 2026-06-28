import React, { useRef, useLayoutEffect, type FC } from "react";
import {
  isConversationMessage,
  isUserMessage,
  useVoiceBot,
  type ConversationMessage,
  type LatencyMessage,
  type AssistantMessage,
} from "../context/VoiceBotContextProvider";
import { UserIcon } from "./icons/UserIcon";
import { AssistantIcon } from "./icons/AssistantIcon";
import { XMarkIcon } from "./icons/XMarkIcon";
import { LightningIcon } from "./icons/LightningIcon";

const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });

const ConversationMessageDisplay: FC<{
  message: ConversationMessage;
  firstInSequence: boolean;
}> = ({ message, firstInSequence }) => (
  <div
    className={`flex flex-col ${
      isUserMessage(message) ? "ml-8 md:ml-16 items-end" : "mr-8 md:mr-16 items-start"
    } ${isUserMessage(message) && firstInSequence ? "mt-4" : "mt-2"}
    ${isUserMessage(message) && message.user === "" ? "italic" : ""}`}
  >
    <div
      className={`flex justify-center items-center gap-2 ${isUserMessage(message) ? "flex-row-reverse" : ""}`}
    >
      <span
        className={`flex-shrink-0 ${firstInSequence ? "" : "opacity-0"}`}
        aria-hidden={!firstInSequence}
      >
        {isUserMessage(message) ? <UserIcon /> : <AssistantIcon />}
      </span>
      <p
        className={`text-gray-200 border py-3 px-6 rounded-2xl ${
          isUserMessage(message) ? "bg-gray-800 border-gray-700 " : "bg-gray-1000  border-gray-800"
        }`}
      >
        {isUserMessage(message)
          ? message.user || "<non-word utterance detected>"
          : message.assistant}
      </p>
    </div>
    {isUserMessage(message) && message.startedAt ? (
      <div className="mr-10 mt-1 flex flex-wrap items-center justify-end gap-x-3 text-gray-450 text-[11px] font-fira">
        <span>开口 {fmtTime(message.startedAt)}</span>
        {message.endedAt ? <span>· 说完 {fmtTime(message.endedAt)}</span> : null}
        {message.silenceBefore != null ? (
          <span>· 开口前静默 {Math.round(message.silenceBefore)} ms</span>
        ) : null}
      </div>
    ) : null}
    {!isUserMessage(message) && message.latency ? (
      <LatencyMessageDisplay message={message.latency} />
    ) : null}
  </div>
);

const formatMs = (seconds: number): string => `${Math.round(seconds * 1000)} ms`;

const LatencyMessageDisplay: FC<{ message: LatencyMessage }> = ({ message }) => {
  if (message.greetingTtfa != null) {
    return (
      <div className="flex flex-col mr-8 md:mr-16 items-start">
        <div className="ml-10 mt-1 mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-gray-450 text-[11px] font-fira">
          <span className="flex items-center gap-1">
            <LightningIcon className="mb-0.5 flex-shrink-0" />
            开场白首帧 ~{message.greetingTtfa} ms
          </span>
          <span className="text-gray-350">(客户端实测 · 无思考步骤)</span>
          {message.networkRtt != null ? <span>· 网络往返 ~{message.networkRtt} ms</span> : null}
          {message.audioDurationMs ? (
            <span>· AI 说话时长 {(message.audioDurationMs / 1000).toFixed(1)} s</span>
          ) : null}
        </div>
      </div>
    );
  }
  const total = message.total_latency ?? message.tts_latency + message.ttt_latency;
  return (
    <div className="flex flex-col mr-8 md:mr-16 items-start">
      <div className="ml-10 mt-1 mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-gray-450 text-[11px] font-fira">
        {message.timestamp && (
          <span>{new Date(message.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}</span>
        )}
        <span className="flex items-center gap-1">
          <LightningIcon className="mb-0.5 flex-shrink-0" />
          思考 (LLM) {formatMs(message.ttt_latency)}
        </span>
        <span>· 合成 (TTS) {formatMs(message.tts_latency)}</span>
        <span>· 总计 {formatMs(total)}</span>
        {message.networkRtt != null ? <span>· 网络往返 ~{message.networkRtt} ms</span> : null}
        {message.networkRtt != null ? (
          <span className="text-gray-350">
            · 感知 ~{Math.round(total * 1000 + message.networkRtt)} ms(估算=总计+网络)
          </span>
        ) : null}
        {message.audioDurationMs ? (
          <span>· AI 说话时长 {(message.audioDurationMs / 1000).toFixed(1)} s</span>
        ) : null}
        {message.eager ? <span className="text-gray-350">· 抢答</span> : null}
        {message.resumed ? <span className="text-gray-350">· 被打断</span> : null}
      </div>
    </div>
  );
};

const isFirstMessageInSpeakerSequence = (
  message: ConversationMessage,
  allMessages: ConversationMessage[],
) => {
  const previousMessage = allMessages[allMessages.indexOf(message) - 1];
  if (!previousMessage) return true;
  return isUserMessage(message) !== isUserMessage(previousMessage);
};

interface Props {
  toggleConversation: () => void;
}

function Conversation({ toggleConversation }: Props) {
  const { displayOrder } = useVoiceBot();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Session summary across completed conversational turns (excludes the greeting).
  const turnLatencies = displayOrder
    .filter((m): m is AssistantMessage => "assistant" in m && !!m.latency && m.latency.greetingTtfa == null)
    .map((m) => m.latency as LatencyMessage);
  const turnCount = turnLatencies.length;
  const avg = (nums: number[]) =>
    nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  const avgTotal = avg(turnLatencies.map((l) => (l.total_latency ?? 0) * 1000));
  const avgPerceived = avg(
    turnLatencies
      .filter((l) => l.networkRtt != null)
      .map((l) => (l.total_latency ?? 0) * 1000 + (l.networkRtt ?? 0)),
  );

  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayOrder]);

  return (
    <div
      className="absolute top-[250px] bottom-[0] left-0 md:left-[20%] w-[100%] md:w-[60%] pt-4 z-10 border border-gray-800 rounded-[1px]"
      style={{
        background: "linear-gradient(0deg, #16161A 47.8%, #25252B 99.86%)",
      }}
    >
      <div className="h-full flex flex-col justify-between">
        <button
          aria-label="Close"
          className="absolute top-0 right-0 mx-4 px-4 py-4 text-gray-350"
          onClick={toggleConversation}
        >
          <XMarkIcon />
        </button>
        <div className="flex justify-center py-4 mx-8 text-[14px] text-gray-450">
          Conversation transcript:
        </div>

        <div ref={scrollRef} className="scrollbar flex flex-col items-center pb-4 overflow-auto">
          <div className="px-4 max-w-xl">
            {displayOrder.map((message, index) =>
              isConversationMessage(message) ? (
                <ConversationMessageDisplay
                  message={message}
                  firstInSequence={isFirstMessageInSpeakerSequence(
                    message,
                    displayOrder.filter(isConversationMessage),
                  )}
                  key={index}
                />
              ) : (
                <LatencyMessageDisplay message={message} key={index} />
              ),
            )}
            {turnCount > 0 ? (
              <div className="mt-4 pt-2 border-t border-gray-800 flex justify-center flex-wrap gap-x-3 text-[11px] text-gray-450 font-fira">
                <span>本次对话 · {turnCount} 轮</span>
                {avgTotal != null ? <span>· 平均总计 {avgTotal} ms</span> : null}
                {avgPerceived != null ? <span>· 平均感知 {avgPerceived} ms</span> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Conversation;
