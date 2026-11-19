import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/digital-agency/cn"

type MenuListType = "standard" | "box"
type MenuListSize = "regular" | "small"

type MenuListProps = React.ComponentProps<"ul"> & {
  indent?: number
}

const MenuList = React.forwardRef<HTMLUListElement, MenuListProps>(
  ({ children, className, indent, style, ...props }, ref) => {
    return (
      <ul
        ref={ref}
        data-slot="menu-list"
        className={cn(
          "relative z-0 text-solid-gray-800 text-dns-16N-130",
          className
        )}
        style={
          indent !== undefined
            ? ({
                ...style,
                "--menu-list-indentation": indent,
              } as React.CSSProperties)
            : style
        }
        {...props}
      >
        {children}
      </ul>
    )
  }
)
MenuList.displayName = "MenuList"

type MenuListItemProps = React.ComponentProps<"li">

const MenuListItem = React.forwardRef<HTMLLIElement, MenuListItemProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <li ref={ref} data-slot="menu-list-item" className={className} {...props}>
        {children}
      </li>
    )
  }
)
MenuListItem.displayName = "MenuListItem"

const menuListItemVariants = cva(
  `
  group/menu-list-item flex items-center gap-x-2 w-[stretch] px-4
  data-[size=regular]:min-h-11 data-[size=regular]:py-2.5
  data-[size=small]:min-h-9 data-[size=small]:py-1.5 data-[size=small]:text-dns-16N-120
  data-[type=standard]:ml-[calc(1rem*var(--menu-list-indentation,0))]
  data-[type=standard]:data-[size=regular]:rounded-8
  data-[type=standard]:data-[size=small]:rounded-4
  data-[type=box]:pl-[calc(1rem+1rem*var(--menu-list-indentation,0))]
  data-[current]:bg-key-100 data-[current]:text-key-1000 data-[current]:font-bold
  [&:has(+_*_[data-current])]:bg-key-50 [&:has(+_*_[data-current])]:text-key-1000
  hover:bg-solid-gray-50 hover:underline hover:underline-offset-[calc(3/16*1rem)]
  data-[current]:hover:bg-key-50 data-[current]:hover:text-key-900
  [&:has(+_*_[data-current]):hover]:bg-key-50 [&:has(+_*_[data-current]):hover]:text-key-900
  focus-visible:relative focus-visible:z-[1] focus-visible:bg-yellow-300
  data-[type=standard]:focus-visible:outline data-[type=standard]:focus-visible:outline-4 data-[type=standard]:focus-visible:outline-black data-[type=standard]:focus-visible:outline-offset-[calc(2/16*1rem)] data-[type=standard]:focus-visible:ring-[calc(2/16*1rem)] data-[type=standard]:focus-visible:ring-yellow-300
  data-[type=box]:focus-visible:outline data-[type=box]:focus-visible:outline-4 data-[type=box]:focus-visible:outline-black data-[type=box]:focus-visible:-outline-offset-4 data-[type=box]:focus-visible:ring-[calc(6/16*1rem)] data-[type=box]:focus-visible:ring-inset data-[type=box]:focus-visible:ring-yellow-300
  disabled:cursor-not-allowed disabled:text-solid-gray-300 disabled:hover:bg-transparent disabled:hover:no-underline disabled:forced-colors:text-[GrayText]
  data-[current]:focus-visible:bg-key-100
  [&:has(+_*_[data-current]):focus-visible]:bg-key-50
`
)

type MenuListItemSharedProps = VariantProps<typeof menuListItemVariants> & {
  type: MenuListType
  size: MenuListSize
  current?: boolean
}

type MenuListItemButtonProps = Omit<React.ComponentProps<"button">, "type"> &
  MenuListItemSharedProps

const MenuListItemButton = React.forwardRef<
  HTMLButtonElement,
  MenuListItemButtonProps
>(({ children, className, type, size, current, ...props }, ref) => {
  return (
    <button
      ref={ref}
      type="button"
      data-slot="menu-list-item-button"
      data-type={type}
      data-size={size}
      data-current={current ? "" : undefined}
      className={cn(menuListItemVariants(), className)}
      {...props}
    >
      {children}
    </button>
  )
})
MenuListItemButton.displayName = "MenuListItemButton"
export { MenuList, MenuListItem, MenuListItemButton, menuListItemVariants }
