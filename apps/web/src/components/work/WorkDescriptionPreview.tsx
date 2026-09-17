import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ children }) => <span className="text-primary underline">{children}</span>,
  img: ({ alt }) => <span>{alt || "Image"}</span>,
  input: ({ checked }) => <span>{checked ? "☑ " : "☐ "}</span>,
};
const plugins = [remarkGfm];

// Card previews stay passive: opening the card reveals the full interactive description.
export const WorkDescriptionPreview = memo(function WorkDescriptionPreview({
  text,
}: {
  text: string;
}) {
  return (
    <div className="pointer-events-none line-clamp-3 max-h-15 min-w-0 overflow-hidden break-words text-sm leading-5 text-muted-foreground [&_p]:m-0 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:whitespace-pre-wrap [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-2">
      <Markdown skipHtml remarkPlugins={plugins} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
