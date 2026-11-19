;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.markdown
  "Safe Markdown rendering for chat messages. The text is tokenized with
  `marked` and the tokens become React elements; no HTML string is ever
  injected, so text coming from the agent cannot run scripts (raw HTML
  in the text shows as text).

  Covers what Claude's answers use: headings, emphasis, nested and task
  lists, inline code and fenced code blocks (with the language and a
  copy button), quotes, GFM tables (with column alignment), links (new
  tab, `noopener noreferrer`, http(s)/mailto only) and rules. While an
  answer streams in, `complete-partial` closes the inline markers of the
  last block so half-written bold or code does not flash as raw `**`."
  (:require-macros [app.main.style :as stl])
  (:require
   ["marked" :refer [Lexer]]
   [app.main.ui.components.copy-button :refer [copy-button*]]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

;; --- Streaming: close what is still open

(def ^:private fence-re
  #"(?m)^ {0,3}(```|~~~)")

(defn- open-fence?
  "True when `text` ends inside a fenced code block."
  [text]
  (odd? (count (re-seq fence-re text))))

(defn- blank-code-spans
  "`text` with every closed inline code span replaced by spaces of the
  same length, so markers inside code are not counted."
  [text]
  (.replace ^js text (js/RegExp. "`[^`\\n]+`" "g")
            (fn [m] (apply str (repeat (count m) " ")))))

(defn- last-index
  [text marker]
  (let [i (.lastIndexOf ^js text marker)]
    (when (>= i 0) i)))

(defn- open-markers
  "Inline markers of `tail` that have no closing partner, as
  `[position marker]`, last opened first."
  [tail]
  (let [ticks   (count (re-seq #"`" tail))
        plain   (blank-code-spans tail)
        strong  (count (re-seq #"\*\*" plain))
        strike  (count (re-seq #"~~" plain))]
    (->> [(when (odd? ticks) [(last-index tail "`") "`"])
          (when (odd? strong) [(last-index plain "**") "**"])
          (when (odd? strike) [(last-index plain "~~") "~~"])]
         (remove nil?)
         (sort-by first >))))

(defn- close-markers
  [tail]
  (reduce (fn [tail [pos marker]]
            (let [after (subs tail (+ pos (count marker)))]
              (if (str/blank? after)
                ;; just typed, nothing to style yet: drop the marker
                (subs tail 0 pos)
                (str tail marker))))
          tail
          (open-markers tail)))

(defn complete-partial
  "Streaming `text` made renderable: in its last block (after the last
  blank line) a half-written link shows its label, and an unclosed
  `**`, `~~` or `` ` `` is closed, or dropped when nothing follows it
  yet. Text inside an open code fence is left as it is (Markdown
  already runs an unclosed fence to the end)."
  [text]
  (if (or (str/blank? text) (open-fence? text))
    text
    (let [split (some-> (last-index text "\n\n") (+ 2))
          head  (if split (subs text 0 split) "")
          tail  (if split (subs text split) text)
          tail  (.replace ^js tail #"\[([^\]\n]*)\]\([^)\s]*$" "$1")]
      (str head (close-markers tail)))))

;; --- Rendering

(defn safe-href
  "`href` when it is an http(s) or mailto link, else nil."
  [href]
  (when (and (string? href)
             (re-find #"(?i)^(https?:|mailto:)" (str/trim href)))
    href))

(declare render-inline)
(declare render-blocks)

(defn- render-inline-token
  [^js token index]
  (let [type (.-type token)
        key  (str type "-" index)]
    (case type
      ("text" "escape")
      (if-let [tokens (.-tokens token)]
        (mf/html [:* {:key key} (render-inline tokens)])
        (mf/html [:* {:key key} (.-text token)]))

      "strong"
      (mf/html [:strong {:key key :class (stl/css :strong)} (render-inline (.-tokens token))])

      "em"
      (mf/html [:em {:key key :class (stl/css :em)} (render-inline (.-tokens token))])

      "del"
      (mf/html [:del {:key key} (render-inline (.-tokens token))])

      "codespan"
      (mf/html [:code {:key key :class (stl/css :inline-code)} (.-text token)])

      "br"
      (mf/html [:br {:key key}])

      "link"
      (if-let [href (safe-href (.-href token))]
        (mf/html [:a {:key key
                      :href href
                      :target "_blank"
                      :rel "noopener noreferrer"
                      :class (stl/css :link)}
                  (render-inline (.-tokens token))])
        (mf/html [:* {:key key} (render-inline (.-tokens token))]))

      "image"
      ;; never loads remote images; a safe source becomes a link
      (if-let [href (safe-href (.-href token))]
        (mf/html [:a {:key key
                      :href href
                      :target "_blank"
                      :rel "noopener noreferrer"
                      :class (stl/css :link)}
                  (or (not-empty (.-text token)) href)])
        (mf/html [:* {:key key} (.-text token)]))

      "checkbox"
      (mf/html [:input {:key key
                        :type "checkbox"
                        :class (stl/css :task-box)
                        :checked (boolean (.-checked token))
                        :read-only true
                        :disabled true}])

      ;; html and anything unknown: shown as plain text
      (mf/html [:* {:key key} (.-raw token)]))))

(defn- render-inline
  [tokens]
  (when tokens
    (->> (array-seq tokens)
         (map-indexed (fn [index token] (render-inline-token token index))))))

(mf/defc code-block*
  {::mf/private true
   ::mf/memo true}
  [{:keys [lang text]}]
  (let [lang (some-> lang str/trim (str/split #"\s+") first not-empty)]
    [:div {:class (stl/css :code-block)}
     [:div {:class (stl/css :code-header)}
      [:span {:class (stl/css :code-lang)}
       (or lang (tr "penforge.chat.markdown.code"))]
      [:> copy-button* {:data text
                        :class (stl/css :code-copy)
                        :aria-label (tr "penforge.chat.markdown.copy-code")}]]
     [:pre {:class (stl/css :code-body)}
      [:code text]]]))

(defn- render-item-token
  "A token inside a list item. In a tight list the item's text runs
  inline after its checkbox instead of becoming a paragraph."
  [^js token index loose?]
  (let [type (.-type token)
        key  (str type "-" index)]
    (case type
      "checkbox"
      (render-inline-token token index)

      "text"
      (if loose?
        (mf/html [:* {:key key} (render-blocks #js [token])])
        (mf/html [:span {:key key :class (stl/css :item-text)}
                  (if-let [tokens (.-tokens token)]
                    (render-inline tokens)
                    (.-text token))]))

      (mf/html [:* {:key key} (render-blocks #js [token])]))))

(defn- render-list-item
  [^js item index]
  (let [loose? (boolean (.-loose item))]
    (mf/html
     [:li {:key (str "item-" index)
           :class (stl/css-case :item true
                                :task-item (.-task item))}
      (->> (array-seq (.-tokens item))
           (map-indexed (fn [i token] (render-item-token token i loose?))))])))

(defn- cell-style
  [align]
  (when (some? align)
    #js {:textAlign align}))

(defn- render-block-token
  [^js token index]
  (let [type (.-type token)
        key  (str type "-" index)]
    (case type
      ("space" "def")
      nil

      "paragraph"
      (mf/html [:p {:key key :class (stl/css :paragraph)} (render-inline (.-tokens token))])

      "heading"
      (let [depth (.-depth token)]
        (mf/html [:p {:key key
                      :role "heading"
                      :aria-level depth
                      :class (stl/css-case :heading true
                                           :heading-1 (= 1 depth)
                                           :heading-2 (= 2 depth)
                                           :heading-3 (= 3 depth)
                                           :heading-4 (<= 4 depth))}
                  (render-inline (.-tokens token))]))

      "code"
      (mf/html [:> code-block* {:key key
                                :lang (.-lang token)
                                :text (.-text token)}])

      "blockquote"
      (mf/html [:blockquote {:key key :class (stl/css :quote)} (render-blocks (.-tokens token))])

      "list"
      (let [items (map-indexed (fn [i item] (render-list-item item i))
                               (array-seq (.-items token)))
            start (.-start token)]
        (if ^boolean (.-ordered token)
          (mf/html [:ol {:key key
                         :class (stl/css :list :list-ordered)
                         :start (when (and (number? start) (not= 1 start)) start)}
                    items])
          (mf/html [:ul {:key key :class (stl/css :list :list-bullet)} items])))

      "hr"
      (mf/html [:hr {:key key :class (stl/css :rule)}])

      "table"
      (let [align (.-align token)]
        (mf/html [:div {:key key :class (stl/css :table-wrapper)}
                  [:table {:class (stl/css :table)}
                   [:thead
                    [:tr
                     (map-indexed (fn [i ^js cell]
                                    (mf/html [:th {:key (str "h-" i)
                                                   :class (stl/css :cell :head-cell)
                                                   :style (cell-style (aget align i))}
                                              (render-inline (.-tokens cell))]))
                                  (array-seq (.-header token)))]]
                   [:tbody
                    (map-indexed (fn [r row]
                                   (mf/html
                                    [:tr {:key (str "r-" r) :class (stl/css :row)}
                                     (map-indexed (fn [i ^js cell]
                                                    (mf/html [:td {:key (str "c-" i)
                                                                   :class (stl/css :cell)
                                                                   :style (cell-style (aget align i))}
                                                              (render-inline (.-tokens cell))]))
                                                  (array-seq row))]))
                                 (array-seq (.-rows token)))]]]))

      "text"
      (mf/html [:p {:key key :class (stl/css :paragraph)}
                (if-let [tokens (.-tokens token)]
                  (render-inline tokens)
                  (.-text token))])

      ;; "html" blocks and anything unknown: plain text
      (mf/html [:p {:key key :class (stl/css :paragraph)} (.-raw token)]))))

(defn- render-blocks
  [tokens]
  (when tokens
    (->> (array-seq tokens)
         (map-indexed (fn [index token] (render-block-token token index))))))

(defn lex
  "Block tokens of `text` (GFM, single line breaks kept), nil when
  `marked` fails."
  [text]
  (try
    (.lex Lexer text #js {:gfm true :breaks true})
    (catch :default _ nil)))

(mf/defc markdown*
  "Markdown `text` as React elements. With `streaming`, the text is
  still arriving: unclosed inline markers of the last block are closed
  first (`complete-partial`)."
  {::mf/memo true}
  [{:keys [text class streaming]}]
  (let [text   (or text "")
        tokens (mf/with-memo [text streaming]
                 (lex (if streaming (complete-partial text) text)))]
    [:div {:class [class (stl/css :markdown)]}
     (if tokens
       (render-blocks tokens)
       [:p {:class (stl/css :paragraph)} text])]))
