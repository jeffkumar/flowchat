"use client";

import { type ComponentProps, memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

type ResponseProps = ComponentProps<typeof Streamdown> & {
  citationHrefs?: string[];
  citationHrefsKey?: string;
};

export const Response = memo(
  ({ className, citationHrefs, citationHrefsKey: _citationHrefsKey, ...props }: ResponseProps) => {
    const citationHrefSet = new Set(
      Array.isArray(citationHrefs) ? citationHrefs.filter(Boolean) : []
    );

    const Link = ({ className: linkClassName, href, children, ...rest }: ComponentProps<"a">) => {
      const childrenText =
        typeof children === "string"
          ? children
          : Array.isArray(children)
            ? children
                .filter((c): c is string => typeof c === "string")
                .join("")
            : "";

      const isCitation =
        typeof href === "string" &&
        citationHrefSet.has(href);

      return (
        <a
          className={cn(
            isCitation
              ? "not-prose ml-1 inline-flex items-center rounded-full border bg-muted/50 px-3 py-1 text-xs font-medium hover:bg-muted"
              : "underline underline-offset-2",
            linkClassName
          )}
          href={href}
          rel="noopener noreferrer"
          target="_blank"
          {...rest}
        >
          {children}
        </a>
      );
    };

    return (
      <Streamdown
        components={{
          // @ts-expect-error - date is not a standard HTML element but can appear in streamed content
          date: "span",
          a: Link,
        }}
        className={cn(
          "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:whitespace-pre-wrap [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto",
          className
        )}
        {...props}
      />
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.className === nextProps.className &&
    prevProps.citationHrefsKey === nextProps.citationHrefsKey
);

Response.displayName = "Response";
