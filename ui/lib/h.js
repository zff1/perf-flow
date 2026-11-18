// Preact + htm 的统一出口。htm 让我们不用构建工具也能写类似 JSX 的模板。
// 注意模板里不要出现裸的 "<" 或 ">" 文字(会被当成标签),用 "≤" "→" 等代替。
import { h, render, Fragment } from 'preact'
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'preact/hooks'
import htm from 'htm'

export const html = htm.bind(h)
export { h, render, Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback }
