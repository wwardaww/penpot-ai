;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-animations-test
  "W32: the chat's animation step line with its Play button and the
  animation settings dialog render."
  (:require
   ["react-dom/server" :as rds]
   [app.common.types.shape :as cts]
   [app.main.data.ai.chat :as chat]
   [app.main.store :as st]
   [app.main.ui.ds.tooltip :as tooltip]
   [app.main.ui.workspace.ai.animations.settings :as settings]
   [app.main.ui.workspace.ai.chat.panel :as panel]
   [app.util.i18n :as i18n]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(mf/defc tooltip-stub*
  "Server rendering has no portals; the real tooltip renders into one."
  [{:keys [children]}]
  children)

(def ^:private load-time-store
  "The store the app's refs were derived from (see the W25 chat UX test)."
  {:state st/state :stream st/stream})

(defn- with-state
  "Run `f` with the load-time store holding `state`, then restore."
  [state f]
  (let [previous {:state st/state :stream st/stream}
        old      @(:state load-time-store)]
    (set! st/state (:state load-time-store))
    (set! st/stream (:stream load-time-store))
    (reset! st/state state)
    (try
      (f)
      (finally
        (reset! st/state old)
        (set! st/state (:state previous))
        (set! st/stream (:stream previous))))))

(defn- render-static
  [element]
  (with-redefs [tooltip/tooltip* tooltip-stub*
                i18n/tr (fn
                          ([key] key)
                          ([key & args] (str/join " " (cons key args))))]
    (rds/renderToStaticMarkup element)))

(defn- workspace-state
  [file-id page-id shapes chat connected]
  {:current-file-id file-id
   :current-page-id page-id
   :files {file-id {:data {:pages-index {page-id {:objects (into {} (map (juxt :id identity)) shapes)}}}}}
   :workspace-local {:selected #{}}
   :workspace-layout #{:layers}
   :penforge {:connection {:status (if connected :connected :disconnected)}
              :chat (merge chat/empty-chat {:conversation-id "c1"} chat)}})

(t/deftest the-animation-step-shows-a-play-button
  (let [card   (cts/setup-shape {:type :rect :name "Card"})
        state  (workspace-state (random-uuid) (random-uuid) [card]
                                {:entries [{:kind :tool :id "a1" :tool-name "penforge_animations"
                                            :status :done :summary "Animated 1 layer"
                                            :code "animations-set"
                                            :params {:node-ids [(str (:id card))] :count 1
                                                     :at "2020-01-01T00:00:00Z"}}]}
                                true)
        markup (with-state state #(render-static (mf/element panel/chat-panel* #js {})))]
    (t/is (str/includes? markup "penforge.animations.step"))
    (t/is (str/includes? markup "data-testid=\"penforge-animation-play\""))
    (t/is (str/includes? markup "penforge.animations.play"))))

(t/deftest the-settings-dialog-renders
  (let [state     (workspace-state (random-uuid) (random-uuid) [] {} false)
        offline   (with-state state #(render-static (mf/element settings/animation-settings-dialog #js {})))
        connected (with-state (assoc-in state [:penforge :connection :status] :connected)
                    #(render-static (mf/element settings/animation-settings-dialog #js {})))]
    (t/is (str/includes? offline "penforge.animations.settings.title"))
    (t/is (str/includes? offline "penforge.animations.settings.not-connected"))
    (t/is (str/includes? connected "penforge.animations.settings.loading")
          "the setting loads from the daemon first")))
