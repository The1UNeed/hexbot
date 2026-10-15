use crate::{Error, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

#[derive(Clone, Hash, PartialEq, Eq)]
pub(crate) enum Scope {
    Bot(String),
    Room(String),
}

/// Only admission holds a read guard. Deletion drains in-flight opens, then
/// keeps its write guard through process closure and the catalog decision.
/// These locks never own either SQLite writer or the product-work boundary.
#[derive(Default)]
pub(crate) struct Admission(Mutex<HashMap<Scope, Weak<RwLock<()>>>>);

impl Admission {
    fn lock(&self, scope: Scope) -> Arc<RwLock<()>> {
        let mut locks = self.0.lock().unwrap();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&scope).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(RwLock::new(()));
        locks.insert(scope, Arc::downgrade(&lock));
        lock
    }

    pub(crate) fn enter(&self, scope: Scope) -> Result<OwnedRwLockReadGuard<()>> {
        self.lock(scope).try_read_owned().map_err(|_| {
            Error::new(
                4211,
                "Deletion is in progress. Try again after it finishes.",
            )
        })
    }

    pub(crate) async fn pause(&self, scope: Scope) -> OwnedRwLockWriteGuard<()> {
        self.lock(scope).write_owned().await
    }
}
