"use client";
import { Suspense, useState } from "react";
import { App } from "./components/App";
import Intelligence from "./components/Intelligence";
import { stsConfig } from "./lib/constants";
import { isConversationMessage, useVoiceBot } from "./context/VoiceBotContextProvider";
import { CaretIcon } from "./components/icons/CaretIcon";
import { withBasePath } from "./utils/deepgramUtils";
import Conversation from "./components/Conversation";
import VoiceSelector from "./components/VoiceSelector/VoiceSelector";
import { isMobile } from "react-device-detect";
import PopupButton from "./components/PopupButton";
import MobileMenu from "./components/MobileMenu";
import Latency from "./components/Latency";
import { PencilIcon } from "./components/icons/PencilIcon";
import InstructionInput from "./components/InstructionInput";
import { TerminalIcon } from "./components/icons/TerminalIcon";
import Header from "./components/Header";
import { useStsQueryParams } from "./hooks/UseStsQueryParams";
import BehindTheScenes from "./components/BehindTheScenes";

const DesktopMenuItems = () => {
  const { prompt } = useStsQueryParams();
  return (
    <>
      <PopupButton
        buttonIcon={<PencilIcon />}
        buttonText={<span>Prompt {prompt && <span className="text-green-spring">*</span>}</span>}
        popupContent={<InstructionInput className="w-96" focusOnMount />}
        tooltipText={prompt ? "Using your custom prompt. Click to edit." : null}
      />
    </>
  );
};

export default function Home() {
  const { messages } = useVoiceBot();
  const [conversationOpen, setConversationOpen] = useState(true);
  const [behindTheScenesOpen, setBehindTheScenesOpen] = useState(false);

  const toggleConversation = () => setConversationOpen(!conversationOpen);

  const has4ConversationMessages = messages.filter(isConversationMessage).length > 3;

  return (
    <main className="h-dvh flex flex-col justify-between pb-12 md:pb-0">
      <div className="flex flex-col flex-grow">
        <div className="h-[20vh] md:h-auto flex-shrink-0">
          <Suspense>
            <Header logoHref={withBasePath("/")} />
          </Suspense>
        </div>

        <div className="flex flex-grow relative">
          {/* Main Content */}
          <div className="flex-1 flex justify-center items-start md:items-center">
            <div className="md:h-full flex flex-col min-w-[80vw] md:min-w-[30vw] max-w-[80vw] justify-center">
              <div className="flex md:order-last md:mt-4 justify-center">
                <Intelligence />
              </div>
              <Suspense>
                <App
                  defaultStsConfig={stsConfig}
                  className="flex-shrink-0 h-auto items-end"
                  requiresUserActionToInitialize={isMobile}
                />
              </Suspense>
              {/* Desktop Conversation Toggle */}
              {has4ConversationMessages ? (
                <div className="hidden md:flex justify-center mt-auto mb-4 md:mt-4 text-gray-350">
                  <button className="text-[14px] text-gray-350 py-4" onClick={toggleConversation}>
                    See full conversation <CaretIcon className="rotate-90 h-4 w-4" />
                  </button>
                </div>
              ) : null}

              {/* "Try saying" prompt suggestions removed — land directly in the conversation view. */}
            </div>
          </div>

          {/* Right Panel (Desktop only) */}
          <div
            className="hidden md:block p-6 pl-0 max-h-screen overflow-hidden"
            style={{ zIndex: 11 }}
          >
            <div className="flex flex-col gap-4">
              {behindTheScenesOpen ? (
                <BehindTheScenes onClose={() => setBehindTheScenesOpen(false)} />
              ) : (
                <>
                  <button
                    className="w-full px-4 py-3 bg-gray-850 hover:bg-gray-800 text-gray-25 rounded-lg transition-colors flex items-center gap-2"
                    onClick={() => setBehindTheScenesOpen(true)}
                  >
                    <TerminalIcon className="w-5 h-5" />
                    <span className="font-medium flex-grow text-left">Backstage</span>
                    <CaretIcon className="w-5 h-5" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Conversation */}
      {conversationOpen && <Conversation toggleConversation={toggleConversation} />}

      {/* Desktop Bottom Stuff */}
      <div className={`hidden md:flex z-0 absolute bottom-0 left-8 right-[320px] mb-8`}>
        <div className="space-y-4">
          <Suspense>
            <DesktopMenuItems />
          </Suspense>
        </div>
        <Suspense>
          <Latency />
        </Suspense>
      </div>

      {/* Mobile Bottom Stuff */}
      <div className={`flex flex-col z-0 items-center md:hidden`}>
        {has4ConversationMessages && (
          <div className="flex justify-center mt-auto text-gray-350">
            <button className="text-sm text-gray-350 pb-8" onClick={toggleConversation}>
              See full conversation <CaretIcon className="rotate-90 h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Mobile Voice Selector */}
      <Suspense>
        <VoiceSelector
          className={`absolute md:hidden bottom-0 left-0 pb-[16px] pl-[16px]`}
          collapsible
        />
        <MobileMenu className="fixed md:hidden bottom-4 right-4 text-gray-200" />
      </Suspense>
    </main>
  );
}
