;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.files
  "Files a user attaches to a chat message (W25): type detection, the
  limits check (the daemon checks again) and reading them as base64."
  (:require
   [app.main.data.ai.protocol :as proto]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [promesa.core :as p]))

(def ^:private extension-types
  {"png" "image/png"
   "jpg" "image/jpeg"
   "jpeg" "image/jpeg"
   "gif" "image/gif"
   "webp" "image/webp"
   "pdf" "application/pdf"
   "md" "text/markdown"
   "markdown" "text/markdown"
   "txt" "text/plain"
   "csv" "text/csv"
   "json" "application/json"})

(def accept
  "Value of the file input's `accept` attribute."
  (str/join "," (concat (keys (:types proto/file-limits))
                        (map #(str "." %) (keys extension-types)))))

(defn file-type
  "Accepted media type of a file named `name` that the browser reports as
  `mime`, or nil. Browsers often report no type (or another one) for
  Markdown files, so the extension decides when the type is not
  accepted."
  [name mime]
  (if (contains? (:types proto/file-limits) mime)
    mime
    (let [extension (some-> name (str/split ".") last str/lower)]
      (when (and (str/includes? (or name "") ".") (some? extension))
        (get extension-types extension)))))

(defn group
  "Size group (`:image`, `:pdf`, `:text`) of an accepted media type."
  [mime]
  (get-in proto/file-limits [:types mime]))

(defn- megabytes
  [bytes]
  (js/Math.round (/ bytes (* 1024 1024))))

(defn check-files
  "Split `files` (maps with `:name`, `:mime` as reported by the browser
  and `:size`) into the ones that can join the `pending` attachments
  and the problems of the others. Returns `{:accepted [file-with-type]
  :problems [{:code :type|:size|:count|:total :name :limit}]}`."
  [pending files]
  (let [{:keys [max-bytes max-files max-total-bytes]} proto/file-limits
        pending-files (filter #(= "file" (:kind %)) pending)]
    (reduce
     (fn [{:keys [accepted] :as result} {:keys [name mime size] :as file}]
       (let [type       (file-type name mime)
             size-group (group type)
             n-files    (+ (count pending-files) (count accepted))
             total      (reduce + 0 (map :size (concat pending-files accepted)))]
         (cond
           (nil? type)
           (update result :problems conj {:code :type :name name})

           (> size (get max-bytes size-group))
           (update result :problems conj {:code :size :name name
                                          :limit (megabytes (get max-bytes size-group))})

           (>= n-files max-files)
           (update result :problems conj {:code :count :name name :limit max-files})

           (> (+ total size) max-total-bytes)
           (update result :problems conj {:code :total :name name
                                          :limit (megabytes max-total-bytes)})

           :else
           (update result :accepted conj (assoc file :mime type)))))
     {:accepted [] :problems []}
     files)))

(defn problem-text
  "Text of a `check-files` problem."
  [{:keys [code name limit]}]
  (case code
    :type (tr "penforge.chat.attach.error.type" name)
    :size (tr "penforge.chat.attach.error.size" name limit)
    :count (tr "penforge.chat.attach.error.count" limit)
    :total (tr "penforge.chat.attach.error.total" limit)
    (tr "penforge.chat.attach.error.read" name)))

(defn- read-base64
  "Promise of the content of a browser `File` as base64."
  [^js file]
  (p/create
   (fn [resolve reject]
     (let [reader (js/FileReader.)]
       (set! (.-onload reader)
             (fn [_]
               (let [url   (.-result reader)
                     comma (.indexOf url ",")]
                 (resolve (subs url (inc comma))))))
       (set! (.-onerror reader) (fn [_] (reject (.-error reader))))
       (.readAsDataURL reader file)))))

(defn- file-info
  [^js file]
  {:name (or (not-empty (.-name file)) "file")
   :mime (.-type file)
   :size (.-size file)
   :file file})

(defn prepare
  "Check the browser `File`s (a FileList or array) against the `pending`
  attachments and read the accepted ones. Promise of `{:attachments
  [proto/file-attachment] :problems [...]}`; a file that cannot be read
  becomes a `:read` problem."
  [pending js-files]
  (let [{:keys [accepted problems]} (check-files pending (map file-info (js/Array.from js-files)))]
    (p/let [results (p/all (map (fn [{:keys [file] :as info}]
                                  (-> (read-base64 file)
                                      (p/then (fn [base64]
                                                {:attachment (proto/file-attachment
                                                              (assoc info :base64 base64))}))
                                      (p/catch (fn [_]
                                                 {:problem {:code :read :name (:name info)}}))))
                                accepted))]
      {:attachments (into [] (keep :attachment) results)
       :problems (into problems (keep :problem) results)})))

(defn files-of
  "Browser `File`s of a clipboard or drag `DataTransfer`, as an array
  (empty when there are none)."
  [^js data-transfer]
  (if-let [files (some-> data-transfer .-files)]
    (js/Array.from files)
    #js []))
