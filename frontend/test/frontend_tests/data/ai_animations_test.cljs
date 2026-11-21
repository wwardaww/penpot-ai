;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-animations-test
  "AI animations (W32): the settings action and dialog state, and the
  chat step's Play button (which layers it plays, when it plays by
  itself, which preview it starts)."
  (:require
   [app.common.uuid :as uuid]
   [app.main.animations.spec :as spec]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.animations :as animations]
   [app.main.data.workspace.animations.events :as anim]
   [app.main.ui.workspace.ai.animations.play :as play]
   [app.main.ui.workspace.ai.animations.settings :as settings]
   [cljs.test :as t :include-macros true]
   [potok.v2.core :as ptk]))

(def ^:private list-id (uuid/next))
(def ^:private button-id (uuid/next))
(def ^:private plain-id (uuid/next))
(def ^:private hover-id (uuid/next))

(defn- with-spec
  [shape anim]
  (assoc shape :plugin-data {spec/plugin-namespace {spec/plugin-key (spec/encode anim)}}))

(def ^:private objects
  {list-id   (with-spec {:id list-id :type :frame :name "Card List" :shapes []}
               {:v 1 :entrance {:effects [{:type "fade"}] :duration 300 :easing "ease-out"}})
   button-id (with-spec {:id button-id :type :rect :name "Sign In" :shapes []}
               {:v 1 :states {:press {:scale 0.97} :hover {:scale 1.03}}})
   hover-id  (with-spec {:id hover-id :type :rect :name "Link" :shapes []}
               {:v 1 :states {:hover {:opacity 0.8}}})
   plain-id  {:id plain-id :type :rect :name "Plain" :shapes []}})

;; --- Settings

(t/deftest settings-action-is-registered
  (let [action (get @actions/registry :ai/animation-settings)]
    (t/is (some? action))
    (t/is (= #{:main-menu :command-palette} (:scopes action)))
    (t/is (true? (animations/can-edit? {:permissions {:can-edit true}})))
    (t/is (false? (animations/can-edit? {:permissions {:can-edit true}
                                         :workspace-global {:read-only? true}})))))

(t/deftest settings-dialog-follows-the-run
  (let [loading {:step :loading}
        loaded  (-> loading
                    (settings/next-state {:type "workflow.started" :run-id "r1"})
                    (settings/next-state {:type "workflow.event" :kind "result"
                                          :payload {:ai-animations false}})
                    (settings/next-state {:type "workflow.done" :ok true}))]
    (t/is (= {:step :ready :value false :error nil} loaded))
    (t/is (= :error (:step (settings/next-state loading {:type "workflow.done" :ok false
                                                         :error "boom"}))))
    (t/is (= "not-connected"
             (:error (settings/next-state loading {:type "error" :code "not-connected"}))))
    (t/is (= loading (settings/next-state loading {:type "workflow.event" :kind "result"
                                                   :payload {:ai-animations "yes"}}))
          "a result without a boolean is ignored")
    (t/is (= {:ai-animations true} (settings/save-params true)))
    (t/is (= {:ai-animations false} (settings/save-params nil)))))

;; --- Play

(t/deftest step-ids-keep-the-layers-of-the-current-page
  (t/is (= [list-id button-id]
           (play/step-ids objects {:node-ids [(str list-id) "not-a-uuid"
                                              (str (uuid/next)) (str button-id)]})))
  (t/is (= [] (play/step-ids objects {:node-ids nil}))))

(t/deftest steps-play-by-themselves-only-when-fresh
  (let [now (js/Date.parse "2026-11-21T10:00:10Z")]
    (t/is (true? (play/fresh? {:at "2026-11-21T10:00:00Z"} now)))
    (t/is (false? (play/fresh? {:at "2026-11-21T09:59:00Z"} now)))
    (t/is (false? (play/fresh? {:at "2026-11-21T10:01:00Z"} now)) "from the future")
    (t/is (false? (play/fresh? {:at "garbage"} now)))
    (t/is (false? (play/fresh? {} now)))))

(t/deftest play-starts-the-right-preview
  (t/is (= ::anim/play-preview (ptk/type (play/play-event objects [list-id button-id]))))
  (t/is (= ::anim/play-state-preview (ptk/type (play/play-event objects [button-id])))
        "a layer with only states shows its press state")
  (t/is (= ::anim/play-state-preview (ptk/type (play/play-event objects [plain-id hover-id]))))
  (t/is (nil? (play/play-event objects [plain-id])))
  (t/is (nil? (play/play-event objects []))))

(t/deftest play-code-matches-the-daemon
  (t/is (= "animations-set" play/code)))
