;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-linked-test
  "Game UI and Existing projects UI (W38): the folder browser, the read
  card of the chat, the Re-Design cards and the project type labels
  render in each of their states."
  (:require
   ["react-dom/server" :as rds]
   [app.main.ui.dashboard.penforge.folder-browser.browser :as browser]
   [app.main.ui.dashboard.penforge.option-cards :as option-cards]
   [app.main.ui.dashboard.penforge.platform-badge :as badge]
   [app.main.ui.workspace.ai.linked.panel :as panel]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn- js-props
  "Shallow JS props (values stay CLJS data, as rumext passes them)."
  [props]
  (let [result #js {}]
    (doseq [[k v] props]
      (unchecked-set result (name k) v))
    result))

(defn- render
  [component props]
  (rds/renderToStaticMarkup (mf/element component (js-props props))))

(def ^:private unity-facts
  {:git true :engine "unity" :markers ["Packages/manifest.json"] :empty false})

;; --- Folder browser

(defn- render-browser
  [props]
  (render browser/folder-browser*
          (merge {:platform :game :onOpen identity :onChoose identity} props)))

(t/deftest browser-lists-drives-first
  (let [html (render-browser {:browser {:status :loaded :path nil
                                        :roots [{:name "C:" :path "C:\\" :kind "drive"}
                                                {:name "Home" :path "C:\\Users\\me" :kind "home"}]
                                        :entries []}})]
    (t/is (str/includes? html "data-testid=\"penforge-folder-browser\""))
    (t/is (str/includes? html "C:\\Users\\me"))
    (t/is (not (str/includes? html "penforge.folder-browser.picked")) "no folder picked at the drives")))

(t/deftest browser-shows-a-game-folder-with-its-facts
  (let [html (render-browser {:browser {:status :loaded :path "D:\\Games\\Quest" :parent "D:\\Games"
                                        :entries [{:name "Assets" :path "D:\\Games\\Quest\\Assets"}]
                                        :facts unity-facts}})]
    (t/is (str/includes? html "Assets"))
    (t/is (str/includes? html "penforge.folder-browser.picked"))
    (t/is (str/includes? html "penforge.folder-browser.fact.unity"))
    (t/is (str/includes? html "penforge.folder-browser.fact.git"))
    (t/is (str/includes? html "Packages/manifest.json"))
    (t/is (not (str/includes? html "penforge.folder-browser.problem")))))

(t/deftest browser-refuses-a-non-game-folder-for-game-ui
  (let [html (render-browser {:browser {:status :loaded :path "D:\\shop" :entries []
                                        :facts {:git false :engine nil :markers ["package.json"]
                                                :empty false}}})]
    (t/is (str/includes? html "penforge.folder-browser.problem.not-a-game"))
    (t/is (str/includes? html "penforge.folder-browser.empty"))))

(t/deftest browser-states-loading-failed-and-desktop
  (t/is (str/includes? (render-browser {:browser {:status :loading :requested "D:\\x"}})
                       "penforge.folder-browser.loading"))
  (t/is (str/includes? (render-browser {:browser {:status :failed
                                                  :error {:code "bad-request" :reason "folder-missing"}}})
                       "penforge.folder-browser.error.folder-missing"))
  (let [html (render-browser {:desktop true :browser {}})]
    (t/is (str/includes? html "penforge.folder-browser.choose"))
    (t/is (str/includes? html "penforge.folder-browser.none"))
    (t/is (not (str/includes? html "penforge.folder-browser.go")) "the native dialog replaces the list")))

(t/deftest error-and-problem-texts
  (t/is (= "penforge.folder-browser.error.not-connected" (browser/error-text {:code "not-connected"})))
  (t/is (= "penforge.folder-browser.error.folder-refused"
           (browser/error-text {:code "bad-request" :reason "folder-refused"})))
  (t/is (= "penforge.folder-browser.error.generic" (browser/error-text {:code "internal"})))
  (t/is (nil? (browser/problem-text nil)))
  (t/is (= ["penforge.folder-browser.fact.unreal"]
           (browser/fact-badges {:engine "unreal" :git false :markers []}))))

;; --- Cards and badges

(t/deftest four-project-type-illustrations-render
  (doseq [illustration [option-cards/web-illustration* option-cards/mobile-illustration*
                        option-cards/game-illustration* option-cards/existing-illustration*]]
    (t/is (str/includes? (render illustration {}) "<svg"))))

(t/deftest platform-labels
  (t/is (= "penforge.platform.game" (badge/platform-label :game)))
  (t/is (= "penforge.platform.existing" (badge/platform-label :existing)))
  (t/is (= "penforge.platform.mobile" (badge/platform-label :mobile)))
  (t/is (= "penforge.platform.web" (badge/platform-label :web))))

;; --- Read card

(defn- render-read
  [props]
  (render panel/read-card*
          (merge {:platform :game :onRetry identity :onOpen identity :onChoose identity
                  :onLink identity}
                 props)))

(t/deftest read-card-states
  (let [running (render-read {:read {:status :running
                                     :progress {:step "inventory" :params {:done 4 :total 10}}}})]
    (t/is (str/includes? running "penforge.linked.reading"))
    (t/is (str/includes? running "penforge.linked.step.inventory"))
    (t/is (str/includes? running "penforge.linked.reading-count")))
  (t/is (str/includes? (render-read {:read nil}) "penforge.linked.reading") "waiting for the read")
  (t/is (= "" (render-read {:read {:status :ready}})) "nothing once read")
  (let [failed (render-read {:read {:status :failed :error {:message "git missing"}}})]
    (t/is (str/includes? failed "penforge.linked.read-failed"))
    (t/is (str/includes? failed "penforge.linked.retry"))
    (t/is (str/includes? failed "git missing")))
  (let [relink (render-read {:read {:status :not-linked}
                             :browser {:status :loaded :path "D:\\Quest" :entries [] :facts unity-facts}})]
    (t/is (str/includes? relink "penforge.linked.relink"))
    (t/is (str/includes? relink "penforge-folder-browser"))
    (t/is (str/includes? relink "penforge.linked.link"))))

;; --- Re-Design cards

(defn- render-redesign
  [redesign]
  (render panel/redesign-card* {:redesign redesign :onConfirm identity :onRevert identity
                                :onDismiss identity}))

(t/deftest redesign-confirm-cards
  (let [existing (render-redesign {:status :confirm :workflow "code-redesign"
                                   :plan {:git true :dirty true :branch "penforge/redesign-20261121-1030"
                                          :screens [{:board-id "b" :name "Home"}]}})
        game     (render-redesign {:status :confirm :workflow "game-ui-export"
                                   :plan {:git false :folder "PenforgeUI" :screens []}})]
    (t/is (str/includes? existing "penforge-redesign-confirm"))
    (t/is (str/includes? existing "penforge.redesign.confirm.branch"))
    (t/is (str/includes? existing "penforge.redesign.confirm.look-only"))
    (t/is (str/includes? existing "penforge.redesign.confirm.dirty"))
    (t/is (str/includes? existing "<textarea") "instructions for the code re-design")
    (t/is (str/includes? game "penforge.redesign.confirm.game"))
    (t/is (str/includes? game "penforge.redesign.confirm.game-safe"))
    (t/is (str/includes? game "penforge.redesign.confirm.game-no-git"))
    (t/is (not (str/includes? game "<textarea")))))

(t/deftest redesign-progress-summary-and-errors
  (t/is (= "" (render-redesign nil)))
  (t/is (str/includes? (render-redesign {:status :planning}) "penforge.redesign.planning"))
  (t/is (str/includes? (render-redesign {:status :running :progress {:step "guard"}})
                       "penforge.redesign.step.guard"))
  (let [done (render-redesign {:status :done :workflow "code-redesign"
                               :result {:branch "penforge/redesign-x" :files-changed ["a.css"]
                                        :screens [{:name "Home" :status "done"}]
                                        :unmatched ["Hero video"]
                                        :outside-look [{:path "src/api.ts" :reason "logic"
                                                        :detail "new fetch call"}]}})]
    (t/is (str/includes? done "penforge-redesign-done"))
    (t/is (str/includes? done "penforge.redesign.done.existing"))
    (t/is (str/includes? done "Hero video"))
    (t/is (str/includes? done "penforge-redesign-outside"))
    (t/is (str/includes? done "src/api.ts"))
    (t/is (str/includes? done "penforge.redesign.done.revert")))
  (let [clean (render-redesign {:status :done :workflow "code-redesign"
                                :result {:files-changed [] :screens [] :outside-look []}})]
    (t/is (not (str/includes? clean "penforge-redesign-outside"))))
  (let [game (render-redesign {:status :done :workflow "game-ui-export"
                               :result {:folder "D:\\Quest\\PenforgeUI" :assets 3
                                        :screens [{:name "HUD" :guide "guides/hud.md"}]}})]
    (t/is (str/includes? game "penforge.redesign.done.game"))
    (t/is (str/includes? game "PenforgeUI")))
  (t/is (str/includes? (render-redesign {:status :failed :error {:message "dirty tree"}})
                       "dirty tree"))
  (t/is (str/includes? (render-redesign {:status :cancelled}) "penforge.redesign.cancelled")))
