import * as React from "react"

import { cn } from "@/lib/digital-agency/cn"

type TextareaProps = Omit<
  React.ComponentProps<"textarea">,
  "placeholder"
> & {
  isError?: boolean
  placeholder?: never
}

const isAriaDisabled = (value: unknown) => value === true || value === "true"

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, isError, readOnly, ...props }, ref) => {
    return (
      // Expose the first-line baseline in Safari.
      <span
        className={String.raw`block text-std-16N-170 before:block before:h-0 before:pt-4 before:-mb-4 before:content-['\200B']`}
      >
        <textarea
          data-slot="textarea"
          className={cn(
            "block w-full max-w-full rounded-8 border bg-white p-4 border-solid-gray-600 text-std-16N-170 text-solid-gray-800",
            "hover:[&:read-write]:border-black",
            "aria-[invalid=true]:border-error-1 aria-[invalid=true]:[&:read-write]:hover:border-red-1000",
            "focus:outline focus:outline-4 focus:outline-black focus:outline-offset-[calc(2/16*1rem)] focus:ring-[calc(2/16*1rem)] focus:ring-yellow-300",
            "read-only:border-dashed",
            "disabled:!border-solid disabled:border-solid-gray-300 disabled:bg-solid-gray-50 disabled:text-solid-gray-420 disabled:forced-colors:text-[GrayText] disabled:forced-colors:border-[GrayText] aria-disabled:border-solid-gray-300 read-only:aria-disabled:border-solid aria-disabled:bg-solid-gray-50 aria-disabled:text-solid-gray-420 aria-disabled:pointer-events-none aria-disabled:forced-colors:text-[GrayText] aria-disabled:forced-colors:border-[GrayText]",
            className
          )}
          aria-invalid={isError || undefined}
          readOnly={isAriaDisabled(props["aria-disabled"]) ? true : readOnly}
          ref={ref}
          {...props}
        />
      </span>
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
