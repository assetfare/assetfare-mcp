// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20DirectV2Minimal {function transfer(address,uint256) external returns(bool);function transferFrom(address,address,uint256) external returns(bool);function approve(address,uint256) external returns(bool);function decimals() external view returns(uint8);}
interface IWETHDirectV2Minimal is IERC20DirectV2Minimal {function deposit() external payable;function withdraw(uint256) external;}
interface ISwapRouter02DirectV2Minimal {
    struct ExactInputSingleParams {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns(uint256 amountOut);
}

/// @notice Ownerless direct native/stable swaps with an exact 1bp AssetFare fee.
/// @dev No business amount maximum and no service-fee maximum.
contract AssetFareDirectSwapExecutorV2 {
    IERC20DirectV2Minimal public immutable STABLE;IWETHDirectV2Minimal public immutable WETH;ISwapRouter02DirectV2Minimal public immutable ROUTER;address public immutable FEE_RECIPIENT;
    uint256 public constant ROUTE_FEE_BPS=1;uint256 private locked=1;
    event DirectSwap(address indexed caller,address indexed recipient,bool nativeToStable,uint256 input,uint256 feeStable,uint256 output);
    constructor(address stable,address weth,address router,address feeRecipient){require(stable!=address(0)&&weth!=address(0)&&router!=address(0)&&feeRecipient!=address(0),"zero address");require(IERC20DirectV2Minimal(stable).decimals()==6,"stable decimals");STABLE=IERC20DirectV2Minimal(stable);WETH=IWETHDirectV2Minimal(weth);ROUTER=ISwapRouter02DirectV2Minimal(router);FEE_RECIPIENT=feeRecipient;}
    modifier nonReentrant(){require(locked==1,"reentrant");locked=2;_;locked=1;}modifier beforeDeadline(uint256 deadline){require(block.timestamp<=deadline,"expired");_;}
    function swapNativeToStable(address recipient,uint24 poolFee,uint8 routeFeeBps,uint256 minimumNetStable,uint256 deadline) external payable nonReentrant beforeDeadline(deadline) returns(uint256 netStable){
        require(recipient!=address(0)&&msg.value>0,"invalid input");require(routeFeeBps==ROUTE_FEE_BPS,"route fee");_validatePoolFee(poolFee);
        WETH.deposit{value:msg.value}();_approve(address(WETH),address(ROUTER),msg.value);
        uint256 grossMinimum=(minimumNetStable*10_000+9_998)/9_999;
        uint256 gross=ROUTER.exactInputSingle(ISwapRouter02DirectV2Minimal.ExactInputSingleParams(address(WETH),address(STABLE),poolFee,address(this),msg.value,grossMinimum,0));_approve(address(WETH),address(ROUTER),0);
        uint256 fee=gross*routeFeeBps/10_000;netStable=gross-fee;require(netStable>=minimumNetStable,"minimum output");_transfer(address(STABLE),FEE_RECIPIENT,fee);_transfer(address(STABLE),recipient,netStable);emit DirectSwap(msg.sender,recipient,true,msg.value,fee,netStable);
    }
    function swapStableToNative(address recipient,uint256 amountIn,uint24 poolFee,uint8 routeFeeBps,uint256 minimumNative,uint256 deadline) external nonReentrant beforeDeadline(deadline) returns(uint256 nativeOut){
        require(recipient!=address(0)&&amountIn>=10_000,"invalid input");require(routeFeeBps==ROUTE_FEE_BPS,"route fee");_validatePoolFee(poolFee);_transferFrom(address(STABLE),msg.sender,address(this),amountIn);
        uint256 fee=amountIn*routeFeeBps/10_000;uint256 swapInput=amountIn-fee;_approve(address(STABLE),address(ROUTER),swapInput);
        nativeOut=ROUTER.exactInputSingle(ISwapRouter02DirectV2Minimal.ExactInputSingleParams(address(STABLE),address(WETH),poolFee,address(this),swapInput,minimumNative,0));_approve(address(STABLE),address(ROUTER),0);require(nativeOut>=minimumNative,"minimum output");_transfer(address(STABLE),FEE_RECIPIENT,fee);WETH.withdraw(nativeOut);(bool ok,)=recipient.call{value:nativeOut}("");require(ok,"native transfer");emit DirectSwap(msg.sender,recipient,false,amountIn,fee,nativeOut);
    }
    function _validatePoolFee(uint24 poolFee) private pure {require(poolFee==100||poolFee==500||poolFee==3000||poolFee==10000,"pool fee");}
    function _approve(address token,address spender,uint256 amount) private {require(IERC20DirectV2Minimal(token).approve(spender,amount),"approve");}
    function _transfer(address token,address to,uint256 amount) private {require(IERC20DirectV2Minimal(token).transfer(to,amount),"transfer");}
    function _transferFrom(address token,address from,address to,uint256 amount) private {require(IERC20DirectV2Minimal(token).transferFrom(from,to,amount),"transferFrom");}
    receive() external payable {require(msg.sender==address(WETH),"only weth");}
}
