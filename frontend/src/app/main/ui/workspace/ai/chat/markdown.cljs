;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.markdown
  "Safe Markdown rendering for chat messages. The text is tokenized with
  `marked` and the tokens become React elements; no HTML string is ever
  injected, so text coming from the agent cannot run scripts."
  (:require-macros [app.main.style :as stl])
  (:require
   ["marked" :refer [Lexer]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn- safe-href
  [href]
  (when (and (string? href)
             (re-find #"^(https?:|mailto:)" (str/trim href)))
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
      (mf/html [:strong {:key key} (render-inline (.-tokens token))])

      "em"
      (mf/html [:em {:key key} (render-inline (.-tokens token))])

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
      (mf/html [:* {:key key} (.-text token)])

      ;; html and anything unknown: shown as plain text
      (mf/html [:* {:key key} (.-raw token)]))))

(defn- render-inline
  [tokens]
  (when tokens
    (->> (array-seq tokens)
         (map-indexed (fn [index token] (render-inline-token token index))))))

(defn- render-list-item
  [^js item index]
  (mf/html
   [:li {:key (str "item-" index)}
    (render-blocks (.-tokens item))]))

(defn- render-block-token
  [^js token index]
  (let [type (.-type token)
        key  (str type "-" index)]
    (case type
      "space"
      nil

      "paragraph"
      (mf/html [:p {:key key :class (stl/css :paragraph)} (render-inline (.-tokens token))])

      "heading"
      (mf/html [:p {:key key :class (stl/css :heading)} (render-inline (.-tokens token))])

      "code"
      (mf/html [:pre {:key key :class (stl/css :code-block)}
                [:code (.-text token)]])

      "blockquote"
      (mf/html [:blockquote {:key key :class (stl/css :quote)} (render-blocks (.-tokens token))])

      "list"
      (let [items (map-indexed (fn [i item] (render-list-item item i))
                               (array-seq (.-items token)))]
        (if ^boolean (.-ordered token)
          (mf/html [:ol {:key key :class (stl/css :list)} items])
          (mf/html [:ul {:key key :class (stl/css :list)} items])))

      "hr"
      (mf/html [:hr {:key key :class (stl/css :rule)}])

      "table"
      (mf/html [:div {:key key :class (stl/css :table-wrapper)}
                [:table {:class (stl/css :table)}
                 [:thead
                  [:tr
                   (map-indexed (fn [i ^js cell]
                                  (mf/html [:th {:key (str "h-" i)} (render-inline (.-tokens cell))]))
                                (array-seq (.-header token)))]]
                 [:tbody
                  (map-indexed (fn [r row]
                                 (mf/html
                                  [:tr {:key (str "r-" r)}
                                   (map-indexed (fn [i ^js cell]
                                                  (mf/html [:td {:key (str "c-" i)} (render-inline (.-tokens cell))]))
                                                (array-seq row))]))
                               (array-seq (.-rows token)))]]])

      ("text")
      (mf/html [:p {:key key :class (stl/css :paragraph)}
                (if-let [tokens (.-tokens token)]
                  (render-inline tokens)
                  (.-text token))])

      (mf/html [:p {:key key :class (stl/css :paragraph)} (.-raw token)]))))

(defn- render-blocks
  [tokens]
  (when tokens
    (->> (array-seq tokens)
         (map-indexed (fn [index token] (render-block-token token index))))))

(defn- lex
  [text]
  (try
    (.lex Lexer text #js {:gfm true :breaks true})
    (catch :default _ nil)))

(mf/defc markdown*
  {::mf/memo true}
  [{:keys [text class]}]
  (let [tokens (mf/with-memo [text] (lex (or text "")))]
    [:div {:class [class (stl/css :markdown)]}
     (if tokens
       (render-blocks tokens)
       [:p {:class (stl/css :paragraph)} text])]))
