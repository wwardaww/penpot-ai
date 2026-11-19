;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.files
  "Files and folders a user attaches to a chat message (W25): type
  detection, the limits check (the daemon checks again) and reading them
  as base64."
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
  "Megabytes of a byte count, with up to two decimals (3.75, 20)."
  [bytes]
  (/ (js/Math.round (* 100 (/ bytes (* 1024 1024)))) 100))

(defn pending-bytes
  "Bytes the pending attachments already take from the message's total:
  files, folders and room reserved for files still being read."
  [pending]
  (reduce + 0 (keep (fn [{:keys [kind size]}]
                      (when (contains? #{"file" "folder"} kind) size))
                    pending)))

(defn check-files
  "Split `files` (maps with `:name`, `:mime` as reported by the browser
  and `:size`) into the ones that can join the `pending` attachments
  and the problems of the others. Returns `{:accepted [file-with-type]
  :problems [{:code :type|:size|:count|:total :name :limit}]}`."
  [pending files]
  (let [{:keys [max-bytes max-files max-total-bytes]} proto/file-limits
        pending-files (filter #(= "file" (:kind %)) pending)
        pending-total (pending-bytes pending)]
    (reduce
     (fn [{:keys [accepted] :as result} {:keys [name mime size] :as file}]
       (let [type       (file-type name mime)
             size-group (group type)
             n-files    (+ (count pending-files) (count accepted))
             total      (+ pending-total (reduce + 0 (map :size accepted)))]
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

(defn- skipped-path?
  "True when a path inside a folder goes through a tool folder or is a
  system file (`proto/folder-limits` `:skipped`)."
  [path]
  (boolean (some (:skipped proto/folder-limits) (str/split path "/"))))

(defn folder-entries
  "Name and files of a folder the user picked: `files` are maps with
  `:path` (relative to the folder, \"/\" separated, as the browser's
  `webkitRelativePath` without the folder's own name), `:size` and
  `:file`. Tool folders and system files are left out and counted in
  `:skipped`."
  [js-files]
  (let [infos (map (fn [^js file]
                     (let [relative (or (not-empty (.-webkitRelativePath file))
                                        (.-name file))
                           parts    (str/split relative "/")]
                       {:folder (when (> (count parts) 1) (first parts))
                        :path (str/join "/" (if (> (count parts) 1) (rest parts) parts))
                        :size (.-size file)
                        :file file}))
                   (js/Array.from js-files))
        kept  (remove (comp skipped-path? :path) infos)]
    {:name (or (some :folder infos) "folder")
     :files (mapv #(dissoc % :folder) kept)
     :skipped (- (count infos) (count kept))}))

(defn check-folder
  "Check a folder (`folder-entries`) against the folder limits and the
  room `pending` attachments leave. Returns `{:accepted folder-or-nil
  :problems [...]}`; a folder is accepted whole or not at all."
  [pending {:keys [name files]}]
  (let [{:keys [max-files max-file-bytes]} proto/folder-limits
        {:keys [max-total-bytes]} proto/file-limits
        total (reduce + 0 (map :size files))
        large (first (filter #(> (:size %) max-file-bytes) files))]
    (cond
      (empty? files)
      {:accepted nil :problems [{:code :folder-empty :name name}]}

      (> (count files) max-files)
      {:accepted nil :problems [{:code :folder-count :name name :limit max-files}]}

      (some? large)
      {:accepted nil :problems [{:code :folder-size :name (:path large)
                                 :limit (megabytes max-file-bytes)}]}

      (> (+ (pending-bytes pending) total) max-total-bytes)
      {:accepted nil :problems [{:code :total :name name
                                 :limit (megabytes max-total-bytes)}]}

      :else
      {:accepted {:name name :files files :size total} :problems []})))

(defn problem-text
  "Text of a `check-files` or `check-folder` problem."
  [{:keys [code name limit]}]
  (case code
    :type (tr "penforge.chat.attach.error.type" name)
    :size (tr "penforge.chat.attach.error.size" name limit)
    :count (tr "penforge.chat.attach.error.count" limit)
    :total (tr "penforge.chat.attach.error.total" limit)
    :folder-empty (tr "penforge.chat.attach.error.folder-empty" name)
    :folder-count (tr "penforge.chat.attach.error.folder-count" name limit)
    :folder-size (tr "penforge.chat.attach.error.folder-size" name limit)
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

(defn check-browser-files
  "`check-files` for browser `File`s (a FileList or array). Synchronous, so
  a caller can reserve the accepted files' room before reading them."
  [pending js-files]
  (check-files pending (map file-info (js/Array.from js-files))))

(defn read-files
  "Read the files `check-browser-files` accepted. Promise of
  `{:attachments [proto/file-attachment] :problems [...]}`; a file that
  cannot be read becomes a `:read` problem. Never rejects."
  [accepted]
  (p/let [results (p/all (map (fn [{:keys [file] :as info}]
                                (-> (read-base64 file)
                                    (p/then (fn [base64]
                                              {:attachment (proto/file-attachment
                                                            (assoc info :base64 base64))}))
                                    (p/catch (fn [_]
                                               {:problem {:code :read :name (:name info)}}))))
                              accepted))]
    {:attachments (into [] (keep :attachment) results)
     :problems (into [] (keep :problem) results)}))

(defn read-folder
  "Read a folder `check-folder` accepted. Promise of `{:attachment
  folder-attachment-with-size}` or `{:problem {:code :read :name path}}`
  when a file cannot be read. Never rejects."
  [{:keys [name files size]}]
  (-> (p/all (map (fn [{:keys [file] :as info}]
                    (p/then (read-base64 file)
                            (fn [base64] (assoc info :base64 base64))))
                  files))
      (p/then (fn [read]
                {:attachment (assoc (proto/folder-attachment name read) :size size)}))
      (p/catch (fn [_]
                 {:problem {:code :read :name name}}))))

(defn object-url
  "Object URL of base64 content of type `mime`; revoke it with
  `js/URL.revokeObjectURL` when done."
  [mime base64]
  (let [binary (js/atob base64)
        bytes  (js/Uint8Array. (.-length binary))]
    (dotimes [index (.-length binary)]
      (aset bytes index (.charCodeAt binary index)))
    (js/URL.createObjectURL (js/Blob. #js [bytes] #js {:type mime}))))

(defn files-of
  "Browser `File`s of a clipboard or drag `DataTransfer`, as an array
  (empty when there are none)."
  [^js data-transfer]
  (if-let [files (some-> data-transfer .-files)]
    (js/Array.from files)
    #js []))
