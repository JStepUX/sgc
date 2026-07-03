import { memo } from 'react';

// The user's centred pill in the reading column — see AssistantMessage for
// Sal's half of the thread.
export const UserPill = memo(function UserPill({ text }: { text: string }) {
  return (
    <div className="my-1.5 flex justify-center">
      <div className="w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-[22px] border border-hairline-strong bg-surface-thin px-5 py-2.5 text-[14.5px] font-light leading-[1.5] text-fg-1 backdrop-blur-[6px]">
        {text}
      </div>
    </div>
  );
});
