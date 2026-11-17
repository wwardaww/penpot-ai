;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.detached.placeholder
  "Pieces of the AI tab tied to the detached chat window: the header
  button that detaches (or docks) the chat and the notice the tab shows
  while the chat is in its own window."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.detached :as detached]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ref:detached?
  (l/derived detached/detached? st/state))

(mf/defc detach-button*
  "Chat header button. In the sidebar it opens the chat in its own
  window; in that window it brings the chat back to the sidebar."
  []
  (let [detached (mf/deref ref:detached?)

        on-click
        (mf/use-fn
         (mf/deps detached)
         #(st/emit! (if detached
                      (detached/dock)
                      (detached/detach))))]

    [:> icon-button* {:variant "ghost"
                      :icon (if detached i/arrow-left i/external-link)
                      :aria-label (if detached
                                    (tr "penforge.detached.dock")
                                    (tr "penforge.detached.detach"))
                      :data-testid "ai-chat-detach"
                      :on-click on-click}]))

(mf/defc detached-placeholder*
  "What the AI tab shows while the chat is open in another window."
  []
  (let [on-show
        (mf/use-fn #(detached/focus-window!))

        on-dock
        (mf/use-fn #(st/emit! (detached/dock)))]

    [:section {:class (stl/css :placeholder)
               :data-testid "ai-chat-detached"}
     [:> icon* {:icon-id i/external-link
                :size "l"
                :class (stl/css :icon)}]
     [:> text* {:as "h2"
                :typography t/body-large
                :class (stl/css :title)}
      (tr "penforge.detached.placeholder.title")]
     [:> text* {:as "p"
                :typography t/body-medium
                :class (stl/css :hint)}
      (tr "penforge.detached.placeholder.hint")]
     [:div {:class (stl/css :actions)}
      [:> button* {:variant "secondary" :on-click on-show}
       (tr "penforge.detached.show")]
      [:> button* {:variant "primary" :on-click on-dock}
       (tr "penforge.detached.dock")]]]))
