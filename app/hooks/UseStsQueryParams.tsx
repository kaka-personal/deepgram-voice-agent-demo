import { defaultVoice } from "app/lib/constants";
import type { StsConfig } from "app/utils/deepgramUtils";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

export const useStsQueryParams = () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [params, setParams] = useState<{
    voice: string;
    prompt: string | null;
    think_provider: string | null;
    think_model: string | null;
  }>({
    voice: searchParams.get("voice") || defaultVoice.canonical_name,
    prompt: searchParams.get("prompt"),
    think_provider: searchParams.get("think_provider"),
    think_model: searchParams.get("think_model"),
  });

  useEffect(() => {
    setParams({
      voice: searchParams.get("voice") || defaultVoice.canonical_name,
      prompt: searchParams.get("prompt"),
      think_provider: searchParams.get("think_provider"),
      think_model: searchParams.get("think_model"),
    });
  }, [searchParams]);

  const applyParamsToConfig = useCallback(
    (config: StsConfig) => {
      const { voice, prompt, think_provider, think_model } = params;

      // Note: `voice` (Deepgram Aura) selection is intentionally NOT applied here.
      // This agent uses Cartesia for Chinese TTS, so we preserve config.agent.speak as-is.
      void voice;
      return {
        ...config,
        agent: {
          ...config.agent,
          think: {
            ...config.agent.think,
            ...(think_provider &&
              think_model && { provider: { type: think_provider, model: think_model } }),
            ...(prompt && {
              prompt: `${config.agent.think.prompt}\n${prompt}`,
            }),
          },
        },
      };
    },
    [params],
  );

  const updateUrlParam = useCallback(
    (param: string, value: string | null) => {
      const url = new URL(window.location.href);
      if (value) {
        url.searchParams.set(param, value);
      } else {
        url.searchParams.delete(param);
      }
      router.replace(url.toString());
    },
    [router],
  );

  const memoizedUpdatePromptUrlParam = useCallback(
    (text: string | null) => updateUrlParam("prompt", text),
    [updateUrlParam],
  );

  const memoizedUpdateVoiceUrlParam = useCallback(
    (voice: string) => updateUrlParam("voice", voice),
    [updateUrlParam],
  );

  return {
    ...params,
    applyParamsToConfig,
    updatePromptUrlParam: memoizedUpdatePromptUrlParam,
    updateVoiceUrlParam: memoizedUpdateVoiceUrlParam,
  };
};
