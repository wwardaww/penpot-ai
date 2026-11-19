;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-chat-markdown-test
  "Chat Markdown (W37): what an answer renders to, that nothing from the
  model becomes HTML, and how half-written text looks while it
  streams."
  (:require
   ["react-dom/server" :as rds]
   [app.main.ui.workspace.ai.chat.markdown :as md]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn- render
  ([text] (render text false))
  ([text streaming]
   (rds/renderToStaticMarkup
    (mf/element md/markdown* #js {:text text :streaming streaming}))))

(defn- has?
  [html part]
  (str/includes? html part))

(def ^:private answer
  (str "# Plan\n\n"
       "## Screens\n\n"
       "Some **bold**, *italic* and `code`.\n\n"
       "- one\n"
       "  - nested\n"
       "- two\n\n"
       "3. three\n"
       "4. four\n\n"
       "| Screen | Width |\n"
       "|:--|--:|\n"
       "| Home | 440 |\n\n"
       "> a quote\n\n"
       "---\n\n"
       "```js\nconst x = 1;\n```\n\n"
       "[docs](https://penpot.app)\n"))

(t/deftest renders-headings-with-levels
  (let [html (render answer)]
    (t/is (has? html "role=\"heading\" aria-level=\"1\""))
    (t/is (has? html "role=\"heading\" aria-level=\"2\""))
    (t/is (has? html ">Plan<"))))

(t/deftest renders-emphasis-and-inline-code
  (let [html (render answer)]
    (t/is (re-find #"<strong[^>]*>bold</strong>" html))
    (t/is (re-find #"<em[^>]*>italic</em>" html))
    (t/is (re-find #"<code[^>]*>code</code>" html))))

(t/deftest renders-nested-and-numbered-lists
  (let [html (render answer)]
    (t/is (re-find #"<ul[^>]*>.*<li[^>]*><span[^>]*>one</span><ul" html)
          "the nested list sits inside the first item")
    (t/is (re-find #"<ol[^>]*start=\"3\"" html) "numbering keeps its start")))

(t/deftest renders-tables-with-alignment
  (let [html (render answer)]
    (t/is (has? html "<table"))
    (t/is (re-find #"<th[^>]*style=\"text-align:left\"[^>]*>Screen</th>" html))
    (t/is (re-find #"<td[^>]*style=\"text-align:right\"[^>]*>440</td>" html))))

(t/deftest renders-code-blocks-with-language-and-copy
  (let [html (render answer)]
    (t/is (re-find #"<pre[^>]*><code>const x = 1;</code></pre>" html))
    (t/is (has? html ">js<"))
    (t/is (has? html "penforge.chat.markdown.copy-code"))))

(t/deftest renders-quotes-rules-and-safe-links
  (let [html (render answer)]
    (t/is (has? html "<blockquote"))
    (t/is (has? html "<hr"))
    (t/is (has? html "href=\"https://penpot.app\""))
    (t/is (has? html "target=\"_blank\""))
    (t/is (has? html "rel=\"noopener noreferrer\""))))

(t/deftest renders-task-lists
  (let [html (render "- [x] done\n- [ ] todo\n")]
    (t/is (re-find #"<input[^>]*type=\"checkbox\"[^>]*checked" html))
    (t/is (has? html ">todo<"))
    (t/is (not (has? html "[x]")))))

(t/deftest never-renders-raw-html
  (let [html (render "<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)>")]
    (t/is (not (has? html "<script")))
    (t/is (not (has? html "<img")))
    (t/is (has? html "&lt;script&gt;"))))

(t/deftest drops-unsafe-links
  (let [html (render "[x](javascript:alert(1)) and ![p](javascript:alert(2))")]
    (t/is (not (has? html "javascript:")))
    (t/is (not (has? html "<a")))))

(t/deftest safe-href-allows-web-and-mail-only
  (t/is (= "https://a.b" (md/safe-href "https://a.b")))
  (t/is (= "HTTP://a.b" (md/safe-href "HTTP://a.b")))
  (t/is (= "mailto:x@y.z" (md/safe-href "mailto:x@y.z")))
  (t/is (nil? (md/safe-href "javascript:alert(1)")))
  (t/is (nil? (md/safe-href "data:text/html,x")))
  (t/is (nil? (md/safe-href nil))))

;; --- Streaming

(t/deftest complete-partial-closes-open-markers
  (t/is (= "Hello **wor**" (md/complete-partial "Hello **wor")))
  (t/is (= "Use `npm i`" (md/complete-partial "Use `npm i")))
  (t/is (= "**bold `code`**" (md/complete-partial "**bold `code")))
  (t/is (= "~~old~~" (md/complete-partial "~~old"))))

(t/deftest complete-partial-drops-a-marker-with-nothing-after-it
  (t/is (= "text " (md/complete-partial "text **")))
  (t/is (= "a " (md/complete-partial "a `"))))

(t/deftest complete-partial-shows-the-label-of-a-half-link
  (t/is (= "see docs" (md/complete-partial "see [docs](https://exa"))))

(t/deftest complete-partial-leaves-finished-text-and-code
  (let [done "**a** and `b`\n\n- c"]
    (t/is (= done (md/complete-partial done))))
  (t/is (= "```js\nlet **x" (md/complete-partial "```js\nlet **x")))
  (t/is (= "`a` **b**" (md/complete-partial "`a` **b")) "closed code spans do not count")
  (t/is (= "**a**\n\nnew **b**" (md/complete-partial "**a**\n\nnew **b"))))

(t/deftest streaming-text-renders-without-raw-markers
  (let [html (render "Working on **the home" true)]
    (t/is (re-find #"<strong[^>]*>the home</strong>" html))
    (t/is (not (has? html "**")))))

(t/deftest streaming-half-code-block-renders-as-code
  (let [html (render "Here:\n\n```css\n.a { color: red" true)]
    (t/is (re-find #"<code>\.a \{ color: red</code>" html))))

(t/deftest streaming-half-table-renders
  (t/is (string? (render "| a | b |\n|--" true)))
  (t/is (has? (render "| a | b |\n|--|--|\n| 1 |" true) "<table")))
