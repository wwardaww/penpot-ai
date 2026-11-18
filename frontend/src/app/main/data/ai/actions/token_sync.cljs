;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.token-sync
  "Design tokens to app code (W21).

  The daemon workflow `token-sync` writes the file's design tokens
  into the generated app's theme file (a generated block in the
  stack's format) and can ask Claude to make the code use them.

  - Action `:ai/token-sync` (main menu, command palette): a sync shown
    in the AI tab, with Claude's pass when the code does not use the
    tokens yet (`link` `auto`); progress and summary are translated
    here.
  - Watcher: while the AI session of a file runs, a change of the
    file's tokens (an edit, a theme or set switch, a chat turn that
    changes tokens) starts a quiet sync a moment later, so the app
    follows the tokens without a click. Projects without an app are
    skipped by the daemon, and so is a switch to other token sets (the
    app keeps the sets of the last manual sync). A quiet sync that
    needs attention (a hand-edited block, a theme that broke the type
    check) leaves a notice in the AI tab.

  After a sync that changed the theme, a live preview is reloaded."
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.generate :as generate]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.preview :as preview]
   [app.main.data.ai.protocol :as proto]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def workflow-name "token-sync")

(def watch-debounce-ms
  "Quiet time after the last token change before the watcher syncs.
  Edits in a row (typing a value, several tokens) make one sync, and
  so one type check of the app."
  3000)

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn can-edit?
  "True when the open file can be changed: edit permission and not in
  read-only mode."
  [state]
  (and (true? (get-in state [:permissions :can-edit]))
       (not (get-in state [:workspace-global :read-only?]))))

;; --- Texts

(defn step-text
  "Translated text of a `progress` step code, or nil for an unknown
  code (the daemon's English `text` stays then)."
  [step]
  (case step
    "read-tokens" (tr "penforge.token-sync.step.read-tokens")
    "export"      (tr "penforge.token-sync.step.export")
    "theme"       (tr "penforge.token-sync.step.theme")
    "link"        (tr "penforge.token-sync.step.link")
    "check"       (tr "penforge.token-sync.step.check")
    nil))

(defn- link-text
  [{:keys [link linked-files]}]
  (case link
    "done"     (tr "penforge.token-sync.summary.linked" (count linked-files))
    "reverted" (tr "penforge.token-sync.summary.reverted")
    nil))

(defn- extra-texts
  "Notes on tokens kept or left out and on files left uncommitted."
  [{:keys [deprecated refused uncommitted preexisting-errors]}]
  (cond-> []
    (seq deprecated)
    (conj (tr "penforge.token-sync.summary.deprecated" (count deprecated)))

    (seq refused)
    (conj (tr "penforge.token-sync.summary.refused" (count refused)))

    (pos? (or preexisting-errors 0))
    (conj (tr "penforge.token-sync.summary.preexisting-errors" preexisting-errors))

    (seq uncommitted)
    (conj (tr "penforge.token-sync.summary.uncommitted" (str/join ", " uncommitted)))))

(defn summary-text
  "Translated summary of a run from its `result` payload."
  [{:keys [outcome token-count theme-file] :as result}]
  (let [total (or token-count 0)
        main  (case outcome
                "updated"           (tr "penforge.token-sync.summary.updated" theme-file total)
                "unchanged"         (tr "penforge.token-sync.summary.unchanged" total)
                "no-tokens"         (tr "penforge.token-sync.summary.no-tokens")
                "no-app"            (if (pos? total)
                                      (tr "penforge.token-sync.summary.no-app" total)
                                      (tr "penforge.token-sync.summary.no-app-empty"))
                "no-theme"          (tr "penforge.token-sync.summary.no-theme")
                "selection-changed" (tr "penforge.token-sync.summary.selection-changed")
                "block-edited"      (tr "penforge.token-sync.summary.block-edited" theme-file)
                "busy"              (tr "penforge.token-sync.summary.busy")
                nil)]
    (when (some? main)
      (str/join " " (concat [main]
                            (some-> (link-text result) vector)
                            (extra-texts result))))))

(defn failed-text
  "Translated text of a `failed` event code, or nil for an unknown one."
  [code]
  (case code
    "penpot-unreachable" (tr "penforge.token-sync.failed.penpot-unreachable")
    "broken-block"       (tr "penforge.token-sync.failed.broken-block")
    "unsafe-theme-path"  (tr "penforge.token-sync.failed.unsafe-theme-path")
    "theme-check-failed" (tr "penforge.token-sync.failed.theme-check-failed")
    nil))

(defn watch-notice-text
  "Text the AI tab shows after a quiet sync that needs the user's
  attention (a hand-edited block left alone, a theme that broke the
  type check), or nil."
  [{:keys [result failed]}]
  (cond
    (= "theme-check-failed" failed)
    (failed-text failed)

    (= "block-edited" (:outcome result))
    (summary-text result)

    :else
    nil))

;; --- Run

(defn reload-preview
  "Reload a live preview so it shows the new theme."
  []
  (ptk/reify ::reload-preview
    ptk/WatchEvent
    (watch [_ state _]
      (if (preview/live? (get-in state [:penforge :preview]))
        (rx/of (preview/reload))
        (rx/empty)))))

(defn notice
  "Show a notice in the AI tab, once per distinct text."
  [text]
  (ptk/reify ::notice
    ptk/UpdateEvent
    (update [_ state]
      (if (and (some? (get-in state [:penforge :chat]))
               (not= text (get-in state [:penforge :token-sync :last-notice])))
        (-> state
            (assoc-in [:penforge :token-sync :last-notice] text)
            (update-in [:penforge :chat :entries] (fnil conj [])
                       {:kind :error :id (str (uuid/next)) :message text}))
        state))))

(defn watch-events
  "Events for one daemon message of a quiet (watcher) sync: the preview
  reload when the theme changed, and a notice at the end when the sync
  needs the user's attention."
  [state* {:keys [type kind payload]}]
  (cond
    (and (= "workflow.event" type) (= "result" kind))
    (do (vswap! state* assoc :result payload)
        (if (:theme-changed payload)
          [(reload-preview)]
          []))

    (and (= "workflow.event" type) (= "failed" kind))
    (do (vswap! state* assoc :failed (:code payload))
        [])

    (= "workflow.done" type)
    (if-let [text (watch-notice-text @state*)]
      [(notice text)]
      [])

    :else
    []))

(defn run-events
  "Events for one daemon message of a sync: translated progress, the
  preview reload when the theme changed, the translated summary or
  failure at the end. `state*` keeps the result payload and the failure
  code between messages."
  [state* {:keys [type kind run-id payload ok]}]
  (cond
    (and (= "workflow.event" type) (= "progress" kind))
    (if-let [text (step-text (:step payload))]
      [(generate/localize-run run-id {:progress (assoc payload :text text)})]
      [])

    (and (= "workflow.event" type) (= "result" kind))
    (do (vswap! state* assoc :result payload)
        (if (:theme-changed payload)
          [(reload-preview)]
          []))

    (and (= "workflow.event" type) (= "failed" kind))
    (do (vswap! state* assoc :failed (:code payload))
        [])

    (and (= "workflow.done" type) ok)
    (if-let [text (some-> (:result @state*) summary-text)]
      [(generate/localize-run run-id {:summary text})]
      [])

    (= "workflow.done" type)
    (if-let [text (some-> (:failed @state*) failed-text)]
      [(generate/localize-run run-id {:error text})]
      [])

    :else
    []))

(defn- follow-run
  "Start the workflow and follow its messages with `handle`
  (`run-events` or `watch-events`)."
  [stream params opts handle]
  (let [rid    (proto/next-rid)
        state* (volatile! {})]
    (rx/merge
     ;; subscribed before the run starts, so no reply is missed
     (->> (chat/workflow-messages stream rid)
          (rx/mapcat #(rx/from (handle state* %))))
     (rx/of (chat/run-workflow workflow-name params (assoc opts :rid rid))))))

(defn sync-tokens
  "Sync the design tokens to the app code, shown in the AI tab. Claude
  makes the code use the tokens when it does not yet."
  []
  (ptk/reify ::sync-tokens
    ptk/WatchEvent
    (watch [_ state stream]
      (rx/concat
       (rx/of (chat/open-chat))
       (if (connected? state)
         (follow-run stream {:link "auto"} {} run-events)
         ;; `run-workflow` shows the "not connected" notice
         (rx/of (chat/run-workflow workflow-name {:link "auto"})))))))

(defn sync-after-change
  "Quiet sync started by the token watcher (no chat entry)."
  []
  (ptk/reify ::sync-after-change
    ptk/WatchEvent
    (watch [_ state stream]
      (if (and (connected? state) (can-edit? state))
        (follow-run stream {:trigger "watch"} {:silent true} watch-events)
        (rx/empty)))))

;; --- Watcher

(defn token-change?
  "True when the tokens of the open file changed between two values of
  its tokens library (not when one is missing: the file loading or
  closing)."
  [previous current]
  (and (some? previous)
       (some? current)
       (not (identical? previous current))
       (not= previous current)))

(defn watch-tokens
  "Sync the app after the open file's tokens change, until the AI
  session of the file stops."
  []
  (ptk/reify ::watch-tokens
    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper (rx/merge
                     (rx/filter (ptk/type? ::client/finalize) stream)
                     (rx/filter (ptk/type? ::client/initialize) stream)
                     (rx/filter (ptk/type? ::watch-tokens) stream))]
        (->> (rx/from-atom refs/tokens-lib {:emit-current-value? true})
             (rx/scan (fn [[_ previous] current] [previous current]) [nil nil])
             (rx/filter (fn [[previous current]] (token-change? previous current)))
             (rx/debounce watch-debounce-ms)
             (rx/map (fn [_] (sync-after-change)))
             (rx/take-until stopper))))))

;; The AI session starts with `client/initialize` (once per open file);
;; the watcher follows it.
(defonce watcher-subscription
  (->> st/stream
       (rx/filter (ptk/type? ::client/initialize))
       (rx/subs! (fn [_] (st/emit! (watch-tokens))))))

;; --- Action

(actions/register-action!
 {:id :ai/token-sync
  :label #(tr "penforge.actions.token-sync")
  :icon i/tokens
  :order 61
  :scopes #{:main-menu :command-palette}
  :visible? can-edit?
  :enabled? can-edit?
  :run (fn [_]
         (st/emit! (sync-tokens)))})
