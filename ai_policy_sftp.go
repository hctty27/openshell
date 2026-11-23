package main

// aiSFTPApprovalPolicy checks both the user-provided path and the resolved
// target, and requires explicit approval for any path involving a symlink.
// This is a policy layer; the SFTP side must separately validate the target.
func aiSFTPApprovalPolicy(mode, tool, original, canonical string, linked bool, modelAsked bool) aiApprovalPolicy {
    result := aiToolApproval(mode, tool, "", "", original, modelAsked)
    if canonical != original {
        target := aiToolApproval(mode, tool, "", "", canonical, modelAsked)
        if target.Required && (!result.Required || target.Policy == "sensitive") {
            result = target
        }
    }
    if linked && !result.Required {
        return aiApprovalPolicy{Required: true, Policy: "unverified"}
    }
    return result
}
