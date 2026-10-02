// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct KeyValue { string key; string value; }

/// Serves one immutable, self-contained HTML document to web3:// clients, through both
///  - ERC-5219 `request()` (selected by ERC-6944 `resolveMode()` = "5219"), which web3:// gateways use, and
///  - ERC-8244 `html()`.
///
/// The document is stored in "data contracts": contracts whose runtime code is 0x00 followed by a slice of
/// the file (the SSTORE2 layout; the 0x00 byte makes the code unexecutable). This contract only records
/// their addresses. It has no owner and no setters, so the page cannot be changed once deployed.
contract VerumSite {
    address[] private chunks;

    constructor(address[] memory chunks_) {
        chunks = chunks_;
    }

    /// ERC-6944: this contract answers ERC-5219 request().
    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    /// ERC-5219. One page: the same document for every path and query.
    function request(string[] memory, KeyValue[] memory)
        external view returns (uint16 statusCode, string memory body, KeyValue[] memory headers)
    {
        headers = new KeyValue[](1);
        headers[0] = KeyValue("Content-Type", "text/html; charset=utf-8");
        return (200, _html(), headers);
    }

    /// ERC-8244.
    function html() external view returns (string memory) {
        return _html();
    }

    function _html() private view returns (string memory) {
        uint256 n = chunks.length;
        uint256 total;
        for (uint256 i; i < n; i++) total += chunks[i].code.length - 1;
        bytes memory out = new bytes(total);
        uint256 pos;
        for (uint256 i; i < n; i++) {
            address c = chunks[i];
            uint256 len = c.code.length - 1;
            assembly { extcodecopy(c, add(add(out, 32), pos), 1, len) }
            pos += len;
        }
        return string(out);
    }
}
