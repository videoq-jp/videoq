import * as React from "react"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/lib/digital-agency/cn"

const utilityLinkStyle = `text-solid-gray-800 text-dns-16N-130 underline underline-offset-[calc(3/16*1rem)]
  hover:decoration-[calc(3/16*1rem)]
  focus-visible:rounded-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:bg-yellow-300 focus-visible:text-blue-1000 focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300`

type UtilityLinkExternalLinkIconProps = React.ComponentProps<"svg">

const UtilityLinkExternalLinkIcon = ({
  className,
  ...rest
}: UtilityLinkExternalLinkIconProps) => {
  return (
    <svg
      aria-label={`${rest["aria-label"] ?? "新規タブで開きます"}`}
      role="img"
      className={cn("ml-1 inline-block align-[-0.15em]", className)}
      fill="none"
      height="16"
      viewBox="0 0 48 48"
      width="16"
      {...rest}
    >
      <path
        className={className ?? ""}
        d="M22 6V9H9V39H39V26H42V42H6V6H22ZM42 6V20H39V11.2L21 29L19 27L36.8 9H28V6H42Z"
        fill="currentColor"
      />
    </svg>
  )
}
UtilityLinkExternalLinkIcon.displayName = "UtilityLinkExternalLinkIcon"

type UtilityLinkProps = React.ComponentPropsWithoutRef<"a"> & {
  asChild?: boolean
  icon?: UtilityLinkExternalLinkIconProps
}

const UtilityLink = React.forwardRef<HTMLAnchorElement, UtilityLinkProps>(
  ({ asChild = false, children, className, icon, target, ...rest }, ref) => {
    const Comp = asChild ? Slot : "a"

    return (
      <Comp
        ref={ref}
        data-slot="utility-link"
        className={cn(utilityLinkStyle, className)}
        target={target}
        {...rest}
      >
        {asChild ? (
          children
        ) : (
          <>
            {children}
            {target === "_blank" && <UtilityLinkExternalLinkIcon {...icon} />}
          </>
        )}
      </Comp>
    )
  }
)
UtilityLink.displayName = "UtilityLink"

export { UtilityLink }
