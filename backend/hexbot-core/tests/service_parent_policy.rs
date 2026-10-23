#[path = "../src/windows_service_parent_policy.rs"]
mod policy;
#[test]
fn acquisition_requires_the_same_live_creator_not_a_reused_or_unverified_pid() {
    let candidate = || policy::Identity {
        pid: 3464,
        created: 100,
        alive: true,
        same_owner: true,
        system_powershell: true,
    };
    assert!(candidate().verified(9036, 200, 3464));
    for case in 0..8 {
        let mut parent = candidate();
        let mut current = 3464;
        match case {
            0 => parent.pid = 0,
            1 => parent.pid = 9036,
            2 => parent.created = 0,
            3 => parent.created = 201,
            4 => parent.alive = false,
            5 => parent.same_owner = false,
            6 => parent.system_powershell = false,
            _ => current = 9876,
        }
        assert!(!parent.verified(9036, 200, current), "case {case}");
    }
}
